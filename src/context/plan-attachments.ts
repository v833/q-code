/**
 * Plan Mode 内部 user 消息附件：周期性注入完整/精简提醒，以及退出 Plan Mode 的标记消息。
 */
import type { ModelMessage } from 'ai'

/** Plan Mode 提醒消息内容前缀。 */
export const PLAN_ATTACHMENT_MARKER = '[plan_mode_attachment]'
/** 退出 Plan Mode 消息内容前缀。 */
export const PLAN_EXIT_MARKER = '[plan_mode_exit]'

const TURNS_BETWEEN_ATTACHMENTS = 5
const FULL_REMINDER_EVERY_N = 5

/** 生成首次或周期性「完整」Plan Mode 规则与计划文件路径说明。 */
export function buildFullPlanModeText(planFilePath: string): string {
  return [
    PLAN_ATTACHMENT_MARKER,
    '',
    'PLAN MODE ACTIVE - 当前处于 Plan Mode。',
    '',
    '工作流：',
    '1. 探索：使用只读工具理解代码结构、约束和已有模式。',
    '2. 跟踪：复杂计划可使用 todo_write 维护会话级任务清单。',
    '3. 计划：使用 plan_write 写入完整实施计划。',
    '4. 退出：计划准备好后调用 exit_plan_mode，等待用户批准。',
    '',
    '计划文件结构：',
    '',
    '## Context',
    '说明要解决的问题、用户需求和预期结果。',
    '',
    '## Recommended approach',
    '写出简洁但可执行的实施方案。',
    '',
    '## Critical files',
    '列出可能创建或修改的关键文件。',
    '',
    '## Reuse',
    '列出应复用的现有函数、工具或项目模式。',
    '',
    '## Verification',
    '说明如何端到端验证实现。',
    '',
    '规则：',
    '- Plan Mode 下不要修改项目文件。',
    '- 不要运行会改变文件、依赖、服务或环境的 shell 命令。',
    '- 可以使用 todo_write 更新会话级任务清单。',
    '- 使用 plan_write 写计划文件，不要使用 write_file/edit_file。',
    '- 计划完成后调用 exit_plan_mode，不要只用普通文本请求批准。',
    '',
    `计划文件: ${planFilePath}`
  ].join('\n')
}

/** 生成周期性「精简」Plan Mode 提醒。 */
export function buildSparsePlanModeText(planFilePath: string): string {
  return [
    PLAN_ATTACHMENT_MARKER,
    '',
    '提醒：你仍处于 Plan Mode。',
    '只能进行只读探索、todo_write 任务跟踪，并使用 plan_write 写计划。',
    `计划文件: ${planFilePath}`,
    '计划准备好后调用 exit_plan_mode。'
  ].join('\n')
}

/**
 * 生成退出 Plan Mode 后的 user 消息正文。
 * @param planExists 为 true 时在文末附带计划文件路径
 */
export function buildPlanModeExitText(planFilePath: string, planExists: boolean): string {
  const lines = [
    PLAN_EXIT_MARKER,
    '',
    '你已退出 Plan Mode，normal 模式工具访问已恢复。',
    '除非用户再次进入 Plan Mode，否则忽略更早的 Plan Mode 提醒。'
  ]

  if (planExists) {
    lines.push(`计划文件: ${planFilePath}`)
  }

  return lines.join('\n')
}

/**
 * 根据自上次附件以来的人类轮次，决定是否需要注入 Plan Mode 提醒消息。
 * @returns 需要注入时的 user 消息，否则 null
 */
export function getPlanModeAttachment(
  messages: readonly ModelMessage[],
  planFilePath: string
): ModelMessage | null {
  const turnsSince = countHumanTurnsSinceLastAttachment(messages)
  if (!hasPlanAttachmentSinceLastExit(messages)) {
    return { role: 'user', content: buildFullPlanModeText(planFilePath) }
  }
  if (turnsSince < TURNS_BETWEEN_ATTACHMENTS) return null

  const attachmentCount = countPlanAttachmentsSinceLastExit(messages) + 1
  const text =
    attachmentCount % FULL_REMINDER_EVERY_N === 1
      ? buildFullPlanModeText(planFilePath)
      : buildSparsePlanModeText(planFilePath)

  return { role: 'user', content: text }
}

/** 生成退出 Plan Mode 时注入的 user 消息。 */
export function getPlanModeExitAttachment(
  planFilePath: string,
  planAlreadyExists: boolean
): ModelMessage {
  return { role: 'user', content: buildPlanModeExitText(planFilePath, planAlreadyExists) }
}

/** 判断是否为 Plan Mode 内部注入的 user 消息（附件或退出）。 */
export function isPlanInternalMessage(message: ModelMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false
  return (
    message.content.startsWith(PLAN_ATTACHMENT_MARKER) ||
    message.content.startsWith(PLAN_EXIT_MARKER)
  )
}

function countHumanTurnsSinceLastAttachment(messages: readonly ModelMessage[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (isPlanInternalMessage(message)) return count
    if (typeof message.content === 'string') count++
  }
  return count
}

function countPlanAttachmentsSinceLastExit(messages: readonly ModelMessage[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    if (message.content.startsWith(PLAN_EXIT_MARKER)) break
    if (message.content.startsWith(PLAN_ATTACHMENT_MARKER)) count++
  }
  return count
}

function hasPlanAttachmentSinceLastExit(messages: readonly ModelMessage[]): boolean {
  return countPlanAttachmentsSinceLastExit(messages) > 0
}
