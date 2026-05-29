/**
 * Agent Monitor 的纯逻辑：SubAgent 排序、元信息格式化，以及 `.output` JSONL tail 读取。
 */
import * as fs from 'node:fs/promises'
import type { TerminalBackgroundAgentItem } from './events'
import type { TaskOutputEvent } from '../agents/task-output'

export const AGENT_OUTPUT_TAIL_MAX_BYTES = 128 * 1024
export const AGENT_OUTPUT_TAIL_MAX_LINES = 160

/** Agent Monitor 详情输出中的一行可渲染内容。 */
export interface AgentOutputLine {
  timestamp?: string
  text: string
  tone: 'info' | 'text' | 'tool' | 'usage' | 'success' | 'error' | 'warning'
}

/** 读取 SubAgent 输出 tail 后的结果。 */
export interface AgentOutputTail {
  lines: AgentOutputLine[]
  warnings: string[]
  fileSize: number
  truncatedBytes: number
}

type TimestampedTaskOutputEvent = TaskOutputEvent & { timestamp?: string }

const STATUS_SORT_RANK: Record<TerminalBackgroundAgentItem['status'], number> = {
  running: 0,
  failed: 1,
  completed: 2,
  killed: 3
}

/** 终端默认只展示仍需关注的 SubAgent；成功完成的条目可通过清理命令从 store 移除。 */
export function filterVisibleAgentMonitorAgents(
  agents: readonly TerminalBackgroundAgentItem[]
): TerminalBackgroundAgentItem[] {
  return agents.filter((agent) => agent.status !== 'completed')
}

/** 将 SubAgent 以“正在运行优先，其次最近启动优先”的顺序排序。 */
export function sortAgentMonitorAgents(
  agents: readonly TerminalBackgroundAgentItem[]
): TerminalBackgroundAgentItem[] {
  return filterVisibleAgentMonitorAgents(agents).sort((left, right) => {
    const statusDelta = STATUS_SORT_RANK[left.status] - STATUS_SORT_RANK[right.status]
    if (statusDelta !== 0) return statusDelta
    return safeTime(right.startedAt) - safeTime(left.startedAt)
  })
}

/** 根据当前列表长度修正选中行，避免背景 Agent 更新后越界。 */
export function clampAgentMonitorSelectedIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.min(Math.max(0, Math.floor(index)), itemCount - 1)
}

/** 取出当前所有仍可停止的后台 SubAgent ID。 */
export function getRunningAgentIds(
  agents: readonly TerminalBackgroundAgentItem[]
): string[] {
  return agents
    .filter(canKillAgent)
    .map((agent) => agent.agentId)
}

/** 当前 Agent 是否处于可停止状态。 */
export function canKillAgent(
  agent: TerminalBackgroundAgentItem | undefined
): agent is TerminalBackgroundAgentItem {
  return agent?.status === 'running' && agent.execution !== 'foreground'
}

/** 忙碌等待期间是否值得提示用户打开 SubAgent Monitor 查看实时输出。 */
export function shouldShowSubAgentWaitHint(
  agents: readonly TerminalBackgroundAgentItem[],
  isBusy: boolean,
  monitorOpen: boolean
): boolean {
  return isBusy && !monitorOpen && agents.some((agent) => agent.status === 'running')
}

/** 等待期底部提示文案。 */
export function formatSubAgentWaitHint(agents: readonly TerminalBackgroundAgentItem[]): string {
  const runningCount = agents.filter((agent) => agent.status === 'running').length
  const suffix = runningCount > 1 ? ` (${runningCount} running)` : ''
  return `等待输出期间可查看 SubAgent 内容${suffix} · Ctrl+A 打开 SubAgent Monitor`
}

/** Ctrl+A 对 SubAgent Monitor 的意图：打开忙碌中的 running 视图，或关闭已打开面板。 */
export function getSubAgentMonitorToggleAction(args: {
  agents: readonly TerminalBackgroundAgentItem[]
  isBusy: boolean
  monitorOpen: boolean
}): 'open' | 'close' | undefined {
  if (args.monitorOpen) return 'close'
  if (args.isBusy && args.agents.some((agent) => agent.status === 'running')) return 'open'
  return undefined
}

/** 格式化 token 数，适合窄终端摘要展示。 */
export function formatCompactNumber(value: number | undefined): string {
  if (value === undefined) return '-'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** 格式化 Agent 运行耗时；running Agent 优先用 startedAt 动态计算。 */
export function formatAgentRuntime(
  agent: TerminalBackgroundAgentItem,
  nowMs = Date.now()
): string {
  if (agent.status === 'running') {
    const started = safeTime(agent.startedAt)
    if (started > 0) return formatDurationMs(Math.max(0, nowMs - started))
  }
  if (agent.durationMs !== undefined) return formatDurationMs(agent.durationMs)
  return '-'
}

/** 把毫秒耗时压缩为短标签。 */
export function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

/** 根据 scrollOffset 截取详情输出窗口；offset=0 表示跟随尾部。 */
export function getVisibleAgentOutputLines(
  lines: readonly AgentOutputLine[],
  maxLines: number,
  scrollOffset: number
): AgentOutputLine[] {
  if (maxLines <= 0 || lines.length === 0) return []
  const safeOffset = Math.min(Math.max(0, Math.floor(scrollOffset)), lines.length)
  const end = Math.max(0, lines.length - safeOffset)
  const start = Math.max(0, end - maxLines)
  return lines.slice(start, end)
}

/** tail 读取并解析 SubAgent `.output` JSONL 文件，异常时返回 warning 而不是抛出。 */
export async function readTaskOutputTail(
  filePath: string | undefined,
  options: { maxBytes?: number; maxLines?: number } = {}
): Promise<AgentOutputTail> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? AGENT_OUTPUT_TAIL_MAX_BYTES))
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? AGENT_OUTPUT_TAIL_MAX_LINES))

  if (!filePath) {
    return {
      lines: [],
      warnings: ['没有可读取的 output 文件路径。'],
      fileSize: 0,
      truncatedBytes: 0
    }
  }

  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) {
      return {
        lines: [],
        warnings: [`output 路径不是文件：${filePath}`],
        fileSize: stat.size,
        truncatedBytes: 0
      }
    }
    if (stat.size === 0) {
      return { lines: [], warnings: [], fileSize: 0, truncatedBytes: 0 }
    }

    const bytesToRead = Math.min(stat.size, maxBytes)
    const offset = stat.size - bytesToRead
    const handle = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(bytesToRead)
      await handle.read(buffer, 0, bytesToRead, offset)
      const rawText = buffer.toString('utf8')
      const text = dropPartialFirstLine(rawText, offset > 0)
      const parsed = parseTaskOutputJsonl(text, maxLines)
      const warnings = [...parsed.warnings]
      if (offset > 0) {
        warnings.unshift(`output 文件较大，已只读取最后 ${formatBytes(bytesToRead)}。`)
      }
      return {
        lines: parsed.lines,
        warnings,
        fileSize: stat.size,
        truncatedBytes: offset
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT') {
      return {
        lines: [],
        warnings: [`output 文件不存在：${filePath}`],
        fileSize: 0,
        truncatedBytes: 0
      }
    }
    return {
      lines: [],
      warnings: [`读取 output 失败：${formatError(error)}`],
      fileSize: 0,
      truncatedBytes: 0
    }
  }
}

function parseTaskOutputJsonl(
  text: string,
  maxLines: number
): { lines: AgentOutputLine[]; warnings: string[] } {
  const records = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines)
  const lines: AgentOutputLine[] = []
  let badLineCount = 0

  for (const line of records) {
    try {
      const parsed = JSON.parse(line) as unknown
      const formatted = formatTaskOutputRecord(parsed)
      if (formatted.length === 0) {
        badLineCount += 1
        continue
      }
      lines.push(...formatted)
    } catch {
      badLineCount += 1
    }
  }

  return {
    lines,
    warnings: badLineCount > 0 ? [`${badLineCount} 行 output JSONL 无法解析，已跳过。`] : []
  }
}

function formatTaskOutputRecord(record: unknown): AgentOutputLine[] {
  if (!isRecord(record) || typeof record.type !== 'string') return []
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined
  const event = record as TimestampedTaskOutputEvent
  switch (event.type) {
    case 'started':
      return [
        outputLine(timestamp, `started ${event.agentType}${event.description ? ` · ${event.description}` : ''}`, 'info')
      ]
    case 'text':
      return [outputLine(timestamp, `text ${clipSingleLine(event.text, 260)}`, 'text')]
    case 'tool_use':
      return [outputLine(timestamp, `tool use: ${event.toolName}`, 'tool')]
    case 'tool_progress':
      return [
        outputLine(timestamp, `tool progress: ${event.toolName} · ${clipSingleLine(event.text, 220)}`, 'tool')
      ]
    case 'tool_result':
      return [
        outputLine(
          timestamp,
          `tool result: ${event.toolName}${event.isError ? ' error' : ''} · ${clipSingleLine(event.preview, 220)}`,
          event.isError ? 'error' : 'tool'
        )
      ]
    case 'turn_usage':
      return [
        outputLine(
          timestamp,
          `usage turn ${event.turn} · in/out ${formatCompactNumber(event.inputTokens)}/${formatCompactNumber(event.outputTokens)} · total ${formatCompactNumber(event.totalTokens)}`,
          'usage'
        )
      ]
    case 'completed':
      return [
        outputLine(
          timestamp,
          `completed · duration ${formatDurationMs(event.durationMs)} · tools ${event.toolUseCount} · tokens ${formatCompactNumber(event.totalTokens)}`,
          'success'
        ),
        outputLine(timestamp, `final ${clipSingleLine(event.finalText, 260)}`, 'success')
      ]
    case 'failed':
      return [
        outputLine(timestamp, `failed · duration ${formatDurationMs(event.durationMs)} · ${clipSingleLine(event.error, 260)}`, 'error')
      ]
  }
  return []
}

function outputLine(
  timestamp: string | undefined,
  text: string,
  tone: AgentOutputLine['tone']
): AgentOutputLine {
  return {
    ...(timestamp ? { timestamp } : {}),
    text,
    tone
  }
}

function dropPartialFirstLine(text: string, shouldDrop: boolean): string {
  if (!shouldDrop) return text
  const newlineIndex = text.indexOf('\n')
  if (newlineIndex === -1) return text
  return text.slice(newlineIndex + 1)
}

function safeTime(value: string | undefined): number {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function clipSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 16))}... truncated`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
