/**
 * 单条工具调用 transcript 的紧凑展示（状态、输入预览、结果摘要）。
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { TranscriptItem } from '../state'
import { compactToolInputPreview, roleColor } from '../utils/format'

/** 渲染 `kind === 'tool'` 的 transcript 条目。 */
export function ToolCallItem({ item }: { item: TranscriptItem }): React.JSX.Element {
  const label = item.title ?? 'Tool'
  const color = roleColor(item)
  const glyph = item.status === 'running' ? '✦' : item.status === 'error' ? '×' : '✓'
  const inputPreview = compactToolInputPreview(item.text)
  const result = formatToolResultSummary(item)
  const meta = [item.meta?.contextCost, item.meta?.resultShape].filter(Boolean).join('/')
  const statusText =
    item.status === 'running' ? 'running' : item.status === 'error' ? 'failed' : 'done'

  return (
    <Box marginLeft={2} flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={color}>{`  ${glyph} ${label}`}</Text>
        <Text dimColor>{` ${statusText}`}</Text>
        {meta ? <Text dimColor>{` [${meta}]`}</Text> : null}
        {inputPreview ? <Text dimColor>{` ${inputPreview}`}</Text> : null}
        {result ? <Text dimColor>{` · ${result}`}</Text> : null}
        {item.agentId ? <Text dimColor>{`  ${item.agentId}`}</Text> : null}
      </Text>
      {item.meta?.recoveryHint ? (
        <Text color="yellow">    {item.meta.recoveryHint}</Text>
      ) : null}
    </Box>
  )
}

function formatToolResultSummary(item: TranscriptItem): string {
  if (item.status === 'running') return 'waiting'
  if (item.meta?.resultLength !== undefined) {
    const size = formatChars(item.meta.resultLength)
    if (item.status !== 'error') return size
  }
  const resultLine = item.text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('Result:') || line.startsWith('Error:'))
  if (!resultLine) return ''
  const value = resultLine.replace(/^(Result|Error):\s*/, '')
  return value.length > 120 ? `${value.slice(0, 117)}...` : value
}

function formatChars(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M chars`
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k chars`
  return `${chars} chars`
}
