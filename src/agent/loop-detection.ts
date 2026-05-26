/**
 * Agent 工具调用循环检测：滑动窗口内识别重复调用、乒乓交替与无进展熔断。
 *
 * 由 `loop.ts` 在每次 `tool-call` 流事件时调用 `detect`；`recordCall` / `recordResult`
 * 维护指纹历史。`critical` 级别会终止 Agent Loop，`warning` 仅注入系统提醒。
 */
import { createHash } from 'node:crypto'

/** 滑动窗口内一条工具调用记录（参数与可选结果指纹）。 */
export interface ToolCallRecord {
  /** 工具名 */
  toolName: string
  /** `hashToolCall(toolName, params)` 的稳定指纹 */
  argsHash: string
  /** 结果指纹；`recordResult` 回填 */
  resultHash?: string
  /** 记录时间戳（毫秒） */
  timestamp: number
}

/** 触发的检测器类型。 */
export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker'

/** `detect` 的判定结果：未卡住，或带级别与文案的卡住状态。 */
export type DetectionResult =
  | { stuck: false }
  | {
      stuck: true
      level: 'warning' | 'critical'
      detector: DetectorKind
      count: number
      message: string
    }

/** 滑动窗口保留的最近调用条数。 */
const HISTORY_SIZE = 30
/** 警告级别阈值（相同参数重复次数或乒乓交替次数）。 */
const WARNING_THRESHOLD = 5
/** 严重级别阈值（触发 critical，Agent Loop 将停止）。 */
const CRITICAL_THRESHOLD = 8
/** 无进展熔断：相同工具+参数且结果指纹连续相同的次数。 */
const BREAKER_THRESHOLD = 10

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/**
 * 工具名 + 参数的稳定指纹（用于窗口内去重与乒乓检测）。
 *
 * @param toolName - 工具名
 * @param params - 工具入参
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`
}

/**
 * 工具结果的稳定指纹（用于无进展 streak 检测）。
 *
 * @param result - 工具输出（已规范化为文本后传入）
 */
export function hashResult(result: unknown): string {
  return hash(stableStringify(result))
}

const history: ToolCallRecord[] = []

/**
 * 记录一次工具调用（在收到 `tool-call` 时调用）。
 *
 * @param toolName - 工具名
 * @param params - 工具入参
 */
export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now()
  })
  if (history.length > HISTORY_SIZE) history.shift()
}

/**
 * 为最近一条匹配的 `recordCall` 回填结果指纹（在 `tool-result` 时调用）。
 *
 * 从窗口末尾向前找首个「同名 + 同 argsHash 且尚无 resultHash」的记录。
 */
export function recordResult(toolName: string, params: unknown, result: unknown): void {
  const argsHash = hashToolCall(toolName, params)
  const resultH = hashResult(result)
  for (let i = history.length - 1; i >= 0; i--) {
    if (
      history[i].toolName === toolName &&
      history[i].argsHash === argsHash &&
      !history[i].resultHash
    ) {
      history[i].resultHash = resultH
      break
    }
  }
}

/** 清空滑动窗口（新 Agent 任务开始时由 `agentLoop` 调用）。 */
export function resetHistory(): void {
  history.length = 0
}

/** 统计「同名+同参且连续多次结果指纹相同」的无进展次数。 */
function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0
  let lastResultHash: string | undefined

  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i]
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue
    if (!r.resultHash) continue
    if (!lastResultHash) {
      lastResultHash = r.resultHash
      streak = 1
      continue
    }
    if (r.resultHash !== lastResultHash) break
    streak++
  }
  return streak
}

/** 检测 A-B-A-B 式参数指纹交替；`currentHash` 为即将执行的本次调用指纹。 */
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0

  const last = history[history.length - 1]
  let otherHash: string | undefined
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash
      break
    }
  }
  if (!otherHash) return 0

  let count = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash
    if (history[i].argsHash !== expected) break
    count++
  }

  if (currentHash === otherHash && count >= 2) return count + 1
  return 0
}

/**
 * 在即将执行工具调用前检测是否陷入循环。
 *
 * 优先级：无进展熔断 > 乒乓循环 > 同参重复调用。
 *
 * @param toolName - 工具名
 * @param params - 工具入参
 */
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params)
  const noProgress = getNoProgressStreak(toolName, argsHash)

  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`
    }
  }

  const pingPong = getPingPongCount(argsHash)
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`
    }
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`
    }
  }

  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === argsHash
  ).length

  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`
    }
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`
    }
  }

  return { stuck: false }
}
