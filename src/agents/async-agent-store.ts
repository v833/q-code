/**
 * 进程内后台 SubAgent / 队友运行状态表。
 *
 * `registerAsyncAgent` 在 `Agent` 工具以 `run_in_background` 启动时登记；
 * UI、`/agents` 与生命周期回调通过订阅接口观察状态变化。
 */
import type { AgentRunResult } from './types'

/** 后台 Agent 的生命周期状态。 */
export type AsyncAgentStatus = 'running' | 'completed' | 'failed' | 'killed'

/** 单个后台 Agent 的运行时条目（含可中止的 `AbortController`）。 */
export interface AsyncAgentEntry {
  agentId: string
  agentType: string
  description: string
  prompt: string
  startedAt: string
  status: AsyncAgentStatus
  abortController: AbortController
  /** JSONL 任务输出文件路径（见 `task-output.ts`）。 */
  outputFile: string
  isolated: boolean
  worktreePath?: string
  worktreeBranch?: string
  toolUseCount: number
  lastToolName?: string
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  turnCount?: number
  finalText?: string
  error?: string
  durationMs?: number
  reason?: string
}

/** `registerAsyncAgent` 的初始化字段（不含运行时派生状态）。 */
export interface RegisterAsyncAgentInit {
  agentId: string
  agentType: string
  description: string
  prompt: string
  outputFile: string
  isolated?: boolean
  worktreePath?: string
  worktreeBranch?: string
}

type AsyncAgentListener = (agentId: string, entry: AsyncAgentEntry | null) => void

const entries = new Map<string, AsyncAgentEntry>()
const listeners = new Set<AsyncAgentListener>()

/**
 * 登记新的后台 Agent。`agentId` 重复时抛错。
 * 初始状态为 `running` 并通知订阅者。
 */
export function registerAsyncAgent(init: RegisterAsyncAgentInit): AsyncAgentEntry {
  if (entries.has(init.agentId)) {
    throw new Error(`Async agent '${init.agentId}' already exists`)
  }

  const entry: AsyncAgentEntry = {
    agentId: init.agentId,
    agentType: init.agentType,
    description: init.description,
    prompt: init.prompt,
    startedAt: new Date().toISOString(),
    status: 'running',
    abortController: new AbortController(),
    outputFile: init.outputFile,
    isolated: init.isolated === true,
    ...(init.worktreePath ? { worktreePath: init.worktreePath } : {}),
    ...(init.worktreeBranch ? { worktreeBranch: init.worktreeBranch } : {}),
    toolUseCount: 0
  }

  entries.set(entry.agentId, entry)
  notify(entry.agentId, entry)
  return entry
}

/** 在仍为 `running` 时合并进度字段（工具计数、token 用量等）。 */
export function updateAsyncAgentProgress(
  agentId: string,
  patch: Partial<
    Pick<
      AsyncAgentEntry,
      'toolUseCount' | 'lastToolName' | 'totalTokens' | 'inputTokens' | 'outputTokens' | 'turnCount'
    >
  >
): void {
  const current = entries.get(agentId)
  if (!current || current.status !== 'running') return
  const next = { ...current, ...patch }
  entries.set(agentId, next)
  notify(agentId, next)
}

/** 标记为 `completed` 并写入 `AgentRunResult` 中的汇总字段。 */
export function completeAsyncAgent(
  agentId: string,
  result: AgentRunResult,
  extra: { worktreePath?: string; worktreeBranch?: string } = {}
): void {
  const current = entries.get(agentId)
  if (!current || current.status !== 'running') return
  const base = applyFinalWorktree(current, extra)

  const next: AsyncAgentEntry = {
    ...base,
    status: 'completed',
    finalText: result.finalText,
    durationMs: result.totalDurationMs,
    totalTokens: result.totalTokens,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    toolUseCount: result.totalToolUseCount,
    turnCount: result.turnCount,
    reason: result.reason ?? 'completed',
    ...(extra.worktreePath ? { worktreePath: extra.worktreePath } : {}),
    ...(extra.worktreeBranch ? { worktreeBranch: extra.worktreeBranch } : {})
  }

  entries.set(agentId, next)
  notify(agentId, next)
}

/** 标记为 `failed` 并记录错误信息与耗时。 */
export function failAsyncAgent(
  agentId: string,
  error: string,
  durationMs: number,
  extra: { worktreePath?: string; worktreeBranch?: string } = {}
): void {
  const current = entries.get(agentId)
  if (!current || current.status !== 'running') return
  const base = applyFinalWorktree(current, extra)

  const next: AsyncAgentEntry = {
    ...base,
    status: 'failed',
    error,
    durationMs,
    reason: 'failed'
  }

  entries.set(agentId, next)
  notify(agentId, next)
}

/**
 * 请求中止后台 Agent：触发 `abortController` 并将状态设为 `killed`。
 * 若已非 `running` 则返回 false。
 */
export function killAsyncAgent(agentId: string): boolean {
  const current = entries.get(agentId)
  if (!current || current.status !== 'running') return false

  current.abortController.abort(new Error('Background agent was killed'))
  const next: AsyncAgentEntry = {
    ...current,
    status: 'killed',
    reason: 'aborted'
  }

  entries.set(agentId, next)
  notify(agentId, next)
  return true
}

/**
 * 生命周期收尾时把条目固化为 `killed`（例如 abort 后由 `runAsyncAgentLifecycle` 调用）。
 * 与 `killAsyncAgent` 不同：不再次调用 `abort()`。
 */
export function markAsyncAgentKilled(
  agentId: string,
  durationMs: number,
  error?: string,
  extra: { worktreePath?: string; worktreeBranch?: string } = {}
): void {
  const current = entries.get(agentId)
  if (!current) return
  const base = applyFinalWorktree(current, extra)

  const next: AsyncAgentEntry = {
    ...base,
    status: 'killed',
    durationMs,
    reason: 'aborted',
    ...(error ? { error } : {})
  }

  entries.set(agentId, next)
  notify(agentId, next)
}

export function getAsyncAgent(agentId: string): AsyncAgentEntry | undefined {
  return entries.get(agentId)
}

export function getAllAsyncAgents(): AsyncAgentEntry[] {
  return [...entries.values()]
}

export function getRunningAsyncAgents(): AsyncAgentEntry[] {
  return getAllAsyncAgents().filter((entry) => entry.status === 'running')
}

/** 订阅状态变更；`entry === null` 表示条目被清除。返回取消订阅函数。 */
export function subscribeAsyncAgents(listener: AsyncAgentListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 清空全部条目并通知订阅者（测试用）。 */
export function clearAllAsyncAgents(): void {
  const ids = [...entries.keys()]
  entries.clear()
  for (const id of ids) notify(id, null)
}

function notify(agentId: string, entry: AsyncAgentEntry | null): void {
  for (const listener of listeners) listener(agentId, entry)
}

/**
 * 终态时合并 worktree 路径：先去掉条目上旧的 worktree 字段，
 * 再按 `extra` 写入（干净 worktree 被删除后 `extra` 为空对象）。
 */
function applyFinalWorktree(
  entry: AsyncAgentEntry,
  extra: { worktreePath?: string; worktreeBranch?: string }
): AsyncAgentEntry {
  const { worktreePath: _worktreePath, worktreeBranch: _worktreeBranch, ...rest } = entry
  return {
    ...rest,
    ...(extra.worktreePath ? { worktreePath: extra.worktreePath } : {}),
    ...(extra.worktreeBranch ? { worktreeBranch: extra.worktreeBranch } : {})
  }
}
