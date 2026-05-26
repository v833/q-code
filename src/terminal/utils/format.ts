/**
 * TUI 文案与样式辅助：路径压缩、角色标签/颜色、错误信息与工具输入预览。
 */
import type { TerminalStatus } from '../events'
import type { TranscriptItem } from '../state'
import { animeTheme, statusMood } from '../theme/index'

/** 过长路径保留尾部，前缀以 `...` 表示。 */
export function compactPath(path: string, max: number): string {
  if (path.length <= max) return path
  return `...${path.slice(-(max - 3))}`
}

/** 将未知错误转为用户可见字符串（优先 `Error.message`）。 */
export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 将内部状态文案本地化为状态栏展示用语。 */
export function statusLabel(status: TerminalStatus, text: string): string {
  return statusMood(status, text)
}

/** transcript 条目的中文角色标签。 */
export function roleLabel(item: TranscriptItem): string {
  if (item.kind === 'context') return '镜头'
  if (item.role === 'assistant') return '旁白'
  if (item.role === 'user') return '你'
  if (item.role === 'tool') return '道具'
  if (item.role === 'error') return '事故'
  return '系统'
}

/** 按角色/状态返回 Ink 颜色名。 */
export function roleColor(item: TranscriptItem): string {
  if (item.status === 'error' || item.role === 'error') return animeTheme.danger
  if (item.status === 'running') return animeTheme.duck
  if (item.role === 'assistant') return animeTheme.candy
  if (item.role === 'user') return animeTheme.mint
  if (item.role === 'tool') return item.status === 'done' ? animeTheme.mint : animeTheme.duck
  return animeTheme.textDim
}

/** 限制对话区展示的行数与字符数，避免超大消息拖垮 TUI。 */
export function clipTextForDisplay(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= 18 && text.length <= 6000) return text
  const clippedLines = lines.slice(-18).join('\n')
  const clipped =
    clippedLines.length > 6000 ? clippedLines.slice(clippedLines.length - 6000) : clippedLines
  return `... clipped for display ...\n${clipped}`
}

/** 从工具 transcript 文本提取简短的 `Input:` JSON 预览。 */
export function compactToolInputPreview(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const input = lines.find((line) => line.startsWith('Input:'))?.replace(/^Input:\s*/, '')
  if (!input || input === '{}') return ''

  try {
    const parsed = JSON.parse(input) as unknown
    const preview = formatToolInputObject(parsed)
    return preview ? `(${truncatePreview(preview)})` : ''
  } catch {
    return `(${truncatePreview(input)})`
  }
}

function formatToolInputObject(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return formatToolInputValue(value)
  }

  return Object.entries(value)
    .map(([key, entry]) => `${key}=${formatToolInputValue(entry)}`)
    .join(', ')
}

function formatToolInputValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(formatToolInputValue).join(', ')}]`
  if (typeof value === 'object') return '{...}'
  return String(value)
}

function truncatePreview(text: string): string {
  return text.length > 180 ? `${text.slice(0, 177)}...` : text
}
