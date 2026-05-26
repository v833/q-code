/**
 * 上下文压缩：microcompact 清理旧工具结果、LLM 摘要压缩长对话，并保留 tool-call 配对安全边界。
 */
import { generateText, type ModelMessage } from 'ai'
import { isOffloadMarkerText } from './offload'
import { estimateMessagesTokens } from './token-budget'

const TOOL_RESULT_PLACEHOLDER = '[old tool result content cleared]'

const CLEARABLE_TOOLS = new Set([
  'read_file',
  'bash',
  'grep',
  'glob',
  'list_directory',
  'edit_file',
  'write_file'
])

const KEEP_RECENT_TOOL_RESULTS = 3
const KEEP_RECENT_MESSAGES = 8

/** `microcompact` 的返回：可能替换后的消息列表与清理的工具结果 part 数。 */
export interface MicrocompactResult {
  messages: ModelMessage[]
  cleared: number
}

/** `summarize` 的返回：压缩后的消息、摘要正文与被压缩的消息条数。 */
export interface CompactionResult {
  messages: ModelMessage[]
  summary: string
  compressedCount: number
}

const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息、下一步计划等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 不要调用工具，只输出摘要正文
- 总长度控制在 1200 字以内`

/** 估算消息列表 token（委托 `estimateMessagesTokens`）。 */
export function estimateTokens(messages: ModelMessage[]): number {
  return estimateMessagesTokens(messages)
}

/**
 * 将较早的可清理工具消息内容替换为占位符，保留最近若干条完整结果。
 */
export function microcompact(messages: ModelMessage[]): MicrocompactResult {
  const clearableIndices = collectClearableToolMessageIndices(messages)
  const toClear = new Set(
    clearableIndices.slice(0, Math.max(0, clearableIndices.length - KEEP_RECENT_TOOL_RESULTS))
  )

  let cleared = 0
  const compacted = messages.map((message, index) => {
    if (!toClear.has(index) || message.role !== 'tool' || !Array.isArray(message.content)) {
      return message
    }

    const nextContent = (message.content as unknown[]).map((part) => {
      const compactedPart = compactToolResultPart(part)
      if (compactedPart !== part) cleared++
      return compactedPart
    })

    return { ...message, content: nextContent } as ModelMessage
  })

  return { messages: cleared > 0 ? compacted : messages, cleared }
}

/**
 * 用 LLM 将较早对话压缩为结构化摘要 user 消息，保留尾部 verbatim 消息。
 * @param model AI SDK 语言模型实例
 * @param existingSummary 已有摘要时与新对话一并送入压缩
 */
export async function summarize(
  model: any,
  messages: ModelMessage[],
  existingSummary?: string,
  options: {
    force?: boolean
    keepRecentMessages?: number
    maxOutputTokens?: number
    focus?: string
  } = {}
): Promise<CompactionResult> {
  const keepRecentMessages = options.keepRecentMessages ?? KEEP_RECENT_MESSAGES
  if (!options.force && messages.length <= keepRecentMessages) {
    return { messages, summary: existingSummary || '', compressedCount: 0 }
  }

  const tailStart = chooseTailStart(messages, keepRecentMessages, options.force === true)
  if (tailStart <= 0) {
    return { messages, summary: existingSummary || '', compressedCount: 0 }
  }

  const toCompress = messages.slice(0, tailStart)
  const toKeep = messages.slice(tailStart)
  const conversationText = renderMessagesForSummary(toCompress)
  if (!conversationText.trim()) {
    return { messages, summary: existingSummary || '', compressedCount: 0 }
  }

  const focusPrompt = options.focus
    ? `\n\n## 压缩重点\n\n用户要求压缩时重点保留：${options.focus}`
    : ''
  const userPrompt = existingSummary
    ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
    : conversationText
  const focusedPrompt = `${userPrompt}${focusPrompt}`

  try {
    const { text: summary } = await generateText({
      model,
      system: COMPRESS_PROMPT,
      prompt: focusedPrompt,
      maxOutputTokens: options.maxOutputTokens
    })

    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`
    }

    return {
      messages: [summaryMessage, ...toKeep],
      summary,
      compressedCount: toCompress.length
    }
  } catch (err) {
    console.error('[Compaction] LLM 摘要失败:', err)
    return { messages, summary: existingSummary || '', compressedCount: 0 }
  }
}

function chooseTailStart(messages: ModelMessage[], desiredTailCount: number, force: boolean): number {
  if (force && messages.at(-1)?.role === 'user' && messages.length > 1) {
    // Preflight compaction runs after the user message is appended but before
    // the model sees it. Keeping that final request verbatim preserves the
    // normal "last message is user" conversation shape and avoids summarizing
    // away the exact instruction the model is about to answer.
    return messages.length - 1
  }

  if (force && messages.length <= desiredTailCount) {
    // A short transcript can still be huge when a single tool result or file read is large.
    // In forced mode we summarize the whole transcript instead of skipping compaction.
    // The summary itself is a user message, so the next model call still has a
    // user-authored instruction to continue from.
    return messages.length
  }

  const tailStart = findPreservedTailStart(messages, desiredTailCount)
  if (force && tailStart <= 0) {
    // If no safe verbatim tail exists, summarizing everything is preferable to sending
    // an invalid or over-budget request. The summary model receives the old messages as
    // plain text, so tool-call/tool-result adjacency is no longer a protocol concern.
    return messages.length
  }

  return tailStart
}

function collectClearableToolMessageIndices(messages: ModelMessage[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message?.role !== 'tool' || !Array.isArray(message.content)) continue
    if (message.content.some((part) => isClearableToolResultPart(part))) indices.push(i)
  }
  return indices
}

function isClearableToolResultPart(
  part: unknown
): part is Record<string, unknown> & { output: unknown } {
  return (
    isRecord(part) &&
    part.type === 'tool-result' &&
    typeof part.toolName === 'string' &&
    CLEARABLE_TOOLS.has(part.toolName)
  )
}

function compactToolResultPart(part: unknown): unknown {
  if (!isClearableToolResultPart(part)) return part
  const output = compactToolOutput(part.output)
  if (output === part.output) return part
  return {
    ...part,
    output
  }
}

function compactToolOutput(output: unknown): unknown {
  if (typeof output === 'string' && isOffloadMarkerText(output)) return output
  if (!isRecord(output)) return { type: 'text', value: TOOL_RESULT_PLACEHOLDER }

  switch (output.type) {
    case 'text':
    case 'error-text':
      if (typeof output.value === 'string' && isOffloadMarkerText(output.value)) return output
      return { ...output, value: TOOL_RESULT_PLACEHOLDER }
    case 'json':
    case 'error-json':
    case 'content':
    case 'execution-denied':
      return { type: 'text', value: TOOL_RESULT_PLACEHOLDER }
    default:
      return { type: 'text', value: TOOL_RESULT_PLACEHOLDER }
  }
}

function findPreservedTailStart(messages: ModelMessage[], desiredCount: number): number {
  let start = Math.max(0, messages.length - desiredCount)

  // AI SDK requires tool-result parts to remain paired with their tool-call.
  while (start > 0) {
    const tail = messages.slice(start)
    if (hasSafeToolBoundary(tail)) return start
    start--
  }

  return 0
}

function hasSafeToolBoundary(messages: ModelMessage[]): boolean {
  const calls = new Set<string>()
  const results = new Set<string>()

  for (const message of messages) {
    for (const id of collectToolCallIds(message)) calls.add(id)
    for (const id of collectToolResultIds(message)) results.add(id)
  }

  for (const id of results) {
    if (!calls.has(id)) return false
  }
  for (const id of calls) {
    if (!results.has(id)) return false
  }

  return true
}

function collectToolCallIds(message: ModelMessage): string[] {
  if (!Array.isArray(message.content)) return []
  const ids: string[] = []
  for (const part of message.content as unknown[]) {
    if (isRecord(part) && part.type === 'tool-call' && typeof part.toolCallId === 'string') {
      ids.push(part.toolCallId)
    }
  }
  return ids
}

function collectToolResultIds(message: ModelMessage): string[] {
  if (!Array.isArray(message.content)) return []
  const ids: string[] = []
  for (const part of message.content as unknown[]) {
    if (isRecord(part) && part.type === 'tool-result' && typeof part.toolCallId === 'string') {
      ids.push(part.toolCallId)
    }
  }
  return ids
}

function renderMessagesForSummary(messages: ModelMessage[]): string {
  return messages
    .map((message) => {
      const content = renderContentForSummary(message.content)
      return content ? `**${message.role}**: ${content}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function renderContentForSummary(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return (content as unknown[])
    .map((part) => {
      if (typeof part === 'string') return part
      if (!isRecord(part)) return safeJsonStringify(part)
      if (typeof part.text === 'string') return part.text
      if (part.type === 'tool-call') {
        return `[tool-call ${String(part.toolName ?? 'unknown')}] ${safeJsonStringify(part.input)}`
      }
      if (part.type === 'tool-result') {
        return `[tool-result ${String(part.toolName ?? 'unknown')}] ${safeJsonStringify(part.output)}`
      }
      return safeJsonStringify(part)
    })
    .filter(Boolean)
    .join('\n')
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? '')
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
