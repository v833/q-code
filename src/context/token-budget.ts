/**
 * 上下文 token 预算估算与告警快照：启发式计数、usage 锚点增量与压缩/阻断阈值。
 */
import type { LanguageModelUsage, ModelMessage } from 'ai'

const TEXT_CHARS_PER_TOKEN = 4
const JSON_CHARS_PER_TOKEN = 2
const MESSAGE_OVERHEAD_TOKENS = 12
const TOOL_BLOCK_OVERHEAD_TOKENS = 24
const FIXED_BINARY_BLOCK_TOKENS = 2000

/** 上下文占用相对阈值的状态。 */
export type ContextWarningState = 'normal' | 'warning' | 'error' | 'blocking'

/** 简化的 input/output/total token 计数。 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * 将上一轮 API 请求的 input usage 作为锚点，用于增量估算后续 prompt token。
 */
export interface UsageAnchor {
  /** 已计入锚点 inputTokens 的消息条数。 */
  messageCount: number
  inputTokens: number
  systemTokens: number
  activeToolSchemaTokens: number
}

/** 当前 prompt 相对上下文窗口的用量与阈值快照。 */
export interface TokenBudgetSnapshot {
  used: number
  limit: number
  effectiveLimit: number
  compactThreshold: number
  warningThreshold: number
  blockingThreshold: number
  ratio: number
  state: ContextWarningState
}

/** 构建 token 预算快照所需的配置。 */
export interface TokenBudgetOptions {
  systemPrompt: string
  activeToolSchemaTokens: number
  contextLimitTokens: number
  compactTriggerRatio: number
  warningRatio?: number
  blockingRatio?: number
  reservedOutputTokens?: number
  usageAnchor?: UsageAnchor
}

/** 从 AI SDK `LanguageModelUsage` 提取 `TokenUsage`，缺省字段按 0 处理。 */
export function usageFromLanguageModelUsage(usage: LanguageModelUsage | undefined): TokenUsage {
  const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0
  const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0
  const totalTokens =
    typeof usage?.totalTokens === 'number' ? usage.totalTokens : inputTokens + outputTokens

  return { inputTokens, outputTokens, totalTokens }
}

/** 按字符启发式估算纯文本 token（约 4 字符/token，至少 1）。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / TEXT_CHARS_PER_TOKEN))
}

function estimateJsonTokens(value: unknown): number {
  const json = safeJsonStringify(value)
  return Math.max(1, Math.ceil(json.length / JSON_CHARS_PER_TOKEN))
}

function estimateToolOutputTokens(output: unknown): number {
  if (typeof output === 'string') return estimateTextTokens(output)
  if (!isRecord(output)) return estimateJsonTokens(output)

  if (typeof output.value === 'string') return estimateTextTokens(output.value)
  if (Array.isArray(output.value)) return estimateJsonTokens(output.value)
  if (output.type === 'execution-denied') return estimateTextTokens(String(output.reason ?? 'denied'))

  return estimateJsonTokens(output)
}

function estimatePartTokens(part: unknown): number {
  if (typeof part === 'string') return estimateTextTokens(part)
  if (!isRecord(part)) return estimateJsonTokens(part)

  switch (part.type) {
    case 'text':
    case 'reasoning':
      return estimateTextTokens(typeof part.text === 'string' ? part.text : '')
    case 'tool-call':
      return (
        TOOL_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(typeof part.toolName === 'string' ? part.toolName : '') +
        estimateJsonTokens(part.input)
      )
    case 'tool-result':
      return (
        TOOL_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(typeof part.toolName === 'string' ? part.toolName : '') +
        estimateToolOutputTokens(part.output)
      )
    case 'file':
    case 'image':
    case 'file-data':
    case 'image-data':
    case 'file-url':
    case 'image-url':
    case 'file-id':
    case 'image-file-id':
      return FIXED_BINARY_BLOCK_TOKENS
    default:
      return estimateJsonTokens(part)
  }
}

function estimateContentTokens(content: ModelMessage['content']): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  if (!Array.isArray(content)) return 0
  return content.reduce((sum, part) => sum + estimatePartTokens(part), 0)
}

/** 估算单条 `ModelMessage` 的 token（含消息固定开销）。 */
export function estimateMessageTokens(message: ModelMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content)
}

/**
 * 估算消息列表 token 总和，并乘以 4/3 作为保守余量。
 */
export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  const raw = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  return Math.ceil((raw * 4) / 3)
}

/**
 * 估算完整 prompt token：system + 工具 schema + 消息；有锚点时只重算后缀增量。
 */
export function estimatePromptTokens(
  messages: readonly ModelMessage[],
  options: Pick<TokenBudgetOptions, 'systemPrompt' | 'activeToolSchemaTokens' | 'usageAnchor'>
): number {
  const systemTokens = estimateTextTokens(options.systemPrompt)
  const fixedTokens = systemTokens + options.activeToolSchemaTokens
  const anchor = options.usageAnchor

  if (anchor && anchor.messageCount >= 0 && anchor.messageCount <= messages.length) {
    const suffix = messages.slice(anchor.messageCount)
    const fixedDelta =
      fixedTokens - (anchor.systemTokens + anchor.activeToolSchemaTokens)
    return Math.max(0, anchor.inputTokens + fixedDelta + estimateMessagesTokens(suffix))
  }

  return fixedTokens + estimateMessagesTokens(messages)
}

/**
 * 用最近一次 API 请求的 input usage 构建锚点；inputTokens ≤ 0 时返回 undefined。
 */
export function buildUsageAnchor(params: {
  requestMessageCount: number
  usage: TokenUsage
  systemPrompt: string
  activeToolSchemaTokens: number
}): UsageAnchor | undefined {
  if (params.usage.inputTokens <= 0) return undefined

  return {
    messageCount: params.requestMessageCount,
    inputTokens: params.usage.inputTokens,
    systemTokens: estimateTextTokens(params.systemPrompt),
    activeToolSchemaTokens: params.activeToolSchemaTokens
  }
}

/**
 * 根据当前消息与配置生成 token 预算快照及 warning/error/blocking 状态。
 */
export function buildTokenBudgetSnapshot(
  messages: readonly ModelMessage[],
  options: TokenBudgetOptions
): TokenBudgetSnapshot {
  const used = estimatePromptTokens(messages, options)
  const warningRatio = options.warningRatio ?? Math.max(0.5, options.compactTriggerRatio - 0.05)
  const blockingRatio = options.blockingRatio ?? 0.98
  const reservedOutputTokens = Math.min(
    options.reservedOutputTokens ?? 0,
    Math.floor(options.contextLimitTokens * 0.2)
  )
  const effectiveLimit = Math.max(1, options.contextLimitTokens - reservedOutputTokens)

  // compact 阈值相对 CONTEXT_LIMIT；blocking 同时受 effectiveLimit（预留输出）约束
  const blockingThreshold = Math.min(
    Math.floor(options.contextLimitTokens * blockingRatio),
    effectiveLimit
  )
  const compactThreshold = Math.min(
    Math.floor(options.contextLimitTokens * options.compactTriggerRatio),
    blockingThreshold
  )
  const warningThreshold = Math.min(
    Math.floor(options.contextLimitTokens * warningRatio),
    compactThreshold
  )

  let state: ContextWarningState = 'normal'
  if (used >= blockingThreshold) {
    state = 'blocking'
  } else if (used >= compactThreshold) {
    state = 'error'
  } else if (used >= warningThreshold) {
    state = 'warning'
  }

  return {
    used,
    limit: options.contextLimitTokens,
    effectiveLimit,
    compactThreshold,
    warningThreshold,
    blockingThreshold,
    ratio: used / options.contextLimitTokens,
    state
  }
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
