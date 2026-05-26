/**
 * Transcript 布局：静态/动态分区、已完成轮次工具折叠与行数估算。
 */
import type { TranscriptItem } from '../state'
import { stringDisplayWidth } from './string-width'

const MIN_TEXT_WIDTH = 20

/**
 * 若一轮对话已有最终 assistant 消息，则隐藏该轮内已完成的 tool 条目。
 */
export function hideCompletedTurnTools(items: TranscriptItem[]): TranscriptItem[] {
  const visible: TranscriptItem[] = []
  let turn: TranscriptItem[] = []

  const flushTurn = () => {
    const hasFinalAssistant = turn.some((item) => item.role === 'assistant' && item.isStreaming !== true)
    for (const item of turn) {
      if (hasFinalAssistant && item.kind === 'tool') continue
      visible.push(item)
    }
  }

  for (const item of items) {
    if (item.role === 'user' && turn.length > 0) {
      flushTurn()
      turn = []
    }
    turn.push(item)
  }

  flushTurn()
  return visible
}

/**
 * 将 transcript 分为 Ink `Static` 区（已结束轮次）与动态区（当前活跃轮次）。
 */
export function splitStaticAndLiveTranscript(items: TranscriptItem[]): {
  staticItems: TranscriptItem[]
  liveItems: TranscriptItem[]
} {
  const firstUserIndex = items.findIndex((item) => item.role === 'user')
  const preludeItems = firstUserIndex === -1 ? hideCompletedTurnTools(items) : []
  const conversationItems = firstUserIndex === -1 ? [] : items.slice(firstUserIndex)

  if (conversationItems.length === 0) {
    return { staticItems: [], liveItems: preludeItems }
  }

  const turns: TranscriptItem[][] = []
  let currentTurn: TranscriptItem[] = []

  for (const item of conversationItems) {
    if (item.role === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn)
      currentTurn = []
    }
    currentTurn.push(item)
  }
  if (currentTurn.length > 0) turns.push(currentTurn)

  let liveTurnIndex = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    if (isLiveTurn(turns[i])) {
      liveTurnIndex = i
      break
    }
  }
  if (liveTurnIndex === -1) {
    return {
      staticItems: hideCompletedTurnTools(conversationItems),
      liveItems: preludeItems
    }
  }

  const staticItems = hideCompletedTurnTools(turns.slice(0, liveTurnIndex).flat())
  const liveItems = [...preludeItems, ...hideCompletedTurnTools(turns.slice(liveTurnIndex).flat())]
  return { staticItems, liveItems }
}

/** 取出尚未写入 Static 区的条目并标记 id 为已打印。 */
export function takeUnprintedStaticItems(
  items: readonly TranscriptItem[],
  printedIds: Set<string>
): TranscriptItem[] {
  const pending = items.filter((item) => !printedIds.has(item.id))
  for (const item of pending) printedIds.add(item.id)
  return pending
}

function isLiveTurn(items: TranscriptItem[]): boolean {
  const hasUser = items.some((item) => item.role === 'user')
  if (!hasUser) return false
  if (items.some((item) => item.role === 'assistant' && item.isStreaming === true)) return true
  if (items.some((item) => item.kind === 'tool' && item.status === 'running')) return true
  return !items.some((item) => item.role === 'assistant' && item.isStreaming !== true)
}

/** 估算单条 transcript 占用的终端行数（上限 10）。 */
export function estimateItemRows(item: TranscriptItem, textWidth = 80): number {
  if (item.kind === 'tool') return 1
  const textRows = estimateWrappedRows(item.text, textWidth)
  return Math.min(10, textRows + 2)
}

/** 估算多行提示符区域行数（含边距）。 */
export function estimatePromptRows(value: string, width: number): number {
  return 4 + estimateWrappedRows(value || ' ', Math.max(MIN_TEXT_WIDTH, width - 4))
}

/** 按显示宽度估算软换行后的行数。 */
export function estimateWrappedRows(text: string, width: number): number {
  const effectiveWidth = Math.max(MIN_TEXT_WIDTH, width)
  return text.split('\n').reduce((rows, line) => {
    const columns = Math.max(1, stringDisplayWidth(line))
    return rows + Math.max(1, Math.ceil(columns / effectiveWidth))
  }, 0)
}
