/**
 * Agent Teams 的 system-reminder 注入：根据功能开关与是否已有活跃团队，
 * 向 lead 的主 Agent 提示建队、派队友与工作流规则。
 */
import { isAgentTeamsEnabled } from '../utils/agent-teams-enabled'
import { getActiveTeam } from './team-context'
import { readTeamFile, TEAM_LEAD_NAME, type TeamFile } from './team-helpers'

/**
 * 三态 system-reminder（对齐产品文档 §六）：
 *
 * 1. 功能关闭 → 空字符串
 * 2. 开启但无活跃团队 → 提示可用 `TeamCreate`
 * 3. 开启且本进程为 lead → 完整 roster + 工作流说明
 */
export function formatTeamsSystemReminder(): string {
  if (!isAgentTeamsEnabled()) return ''

  const active = getActiveTeam()
  if (!active) {
    return [
      '<system-reminder>',
      'Agent Teams 已启用。',
      '当用户的任务可以拆成几个长期并行、需要互相通信的角色时（如 backend + frontend + reviewer），调用 `TeamCreate` 开启团队会话。',
      '调用 `TeamCreate` 后，使用 `Agent({ name, team_name, run_in_background: true, ... })` 派出命名队友，再通过 `SendMessage` 与队友直接对话。',
      '日常单步任务请继续用普通 `Agent(...)` 而不是建团队。',
      '</system-reminder>'
    ].join('\n')
  }

  const file = readTeamFile(active.teamName)
  if (!file) {
    return [
      '<system-reminder>',
      `Agent Teams 已启用，且当前进程注册为团队 "${active.teamName}" 的 lead，但磁盘上找不到 team.json。`,
      '请告知用户后调用 `TeamDelete` 清空状态再重试。',
      '</system-reminder>'
    ].join('\n')
  }

  return formatActiveTeamReminder(file)
}

/** 为已建团队生成含成员 roster 与工作流步骤的 reminder 正文。 */
function formatActiveTeamReminder(file: TeamFile): string {
  const teammates = file.members.filter((m) => m.name !== TEAM_LEAD_NAME)
  const active = teammates.filter((m) => m.isActive)
  const idle = teammates.filter((m) => !m.isActive)

  const roster: string[] = []
  if (teammates.length === 0) {
    roster.push('(暂无队友。用 `Agent({ name, team_name, run_in_background: true, ... })` 派出第一个队友。)')
  } else {
    for (const m of active) {
      roster.push(`  - ${m.name} [active] type=${m.agentType ?? 'general-purpose'}`)
    }
    for (const m of idle) {
      roster.push(`  - ${m.name} [idle]   type=${m.agentType ?? 'general-purpose'}`)
    }
  }

  return [
    '<system-reminder>',
    `[Agent Teams] 你正在以 lead 身份指挥团队 "${file.name}"。`,
    file.description ? `团队目标：${file.description}` : '',
    '',
    '团队成员：',
    `  - ${TEAM_LEAD_NAME} [you]`,
    ...roster,
    '',
    '工作流：',
    '  1. 派队友：`Agent({ subagent_type, name, team_name: "' +
      file.name +
      '", run_in_background: true, prompt, description })` — 命名队友必须后台运行。',
    '  2. 给队友发消息：`SendMessage({ to: "<name>", message: "...", summary: "..." })`，`to: "*"` 可广播给所有 active 队友。',
    '  3. 等队友完成会收到 `<task-notification>`；如需中断，用 SendMessage 让对方收尾，或 `/agents kill <agent_id>`。',
    '  4. 所有队友 isActive=false 之后调用 `TeamDelete` 解散团队。',
    '',
    '注意：',
    '  - 整个进程同一时间只能有一个团队，已经在团队中时不要再调 TeamCreate。',
    '  - 队友自身不能再 TeamCreate / TeamDelete 或派子团队，但可以互相 SendMessage。',
    '  - 普通单步子任务请用 `Agent(...)` 不带 name/team_name；只有需要跨角色对齐时才走团队。',
    '</system-reminder>'
  ]
    .filter(Boolean)
    .join('\n')
}
