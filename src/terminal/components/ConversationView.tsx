/**
 * 对话 transcript 列表：按条目类型渲染用户/助手/系统/工具/上下文行。
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { TranscriptItem } from '../state'
import { clipTextForDisplay, roleColor, roleLabel } from '../utils/format'
import { MarkdownText } from './MarkdownText'
import { ToolCallItem } from './ToolCallList'
import { animeTheme, formatPromptGlyph } from '../theme/index'
import { STARTUP_DUCK_SOURCE } from '../utils/duck'

/**
 * 渲染一组 {@link TranscriptItem}（Static 区每次一条，动态区可为多条）。
 */
export function ConversationView({ items }: { items: TranscriptItem[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <TranscriptLine key={item.id} item={item} />
      ))}
    </Box>
  )
}

function TranscriptLine({ item }: { item: TranscriptItem }): React.JSX.Element {
  const color = roleColor(item)
  const label = item.title ?? roleLabel(item)

  if (item.kind === 'tool') {
    return <ToolCallItem item={item} />
  }

  if (item.role === 'system' && item.source === STARTUP_DUCK_SOURCE) {
    return <StartupDuckBanner text={item.text} />
  }

  if (item.role === 'user') {
    return (
      <Box marginTop={1}>
        <Text color={animeTheme.mint} bold>{formatPromptGlyph()}</Text>
        <Text>{clipTextForDisplay(item.text)}</Text>
      </Box>
    )
  }

  if (item.role === 'assistant') {
    return (
      <Box flexDirection="row">
        <Box width={2}>
          <Text color={animeTheme.candy}>▎</Text>
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          <MarkdownText text={item.text} streaming={item.isStreaming === true} />
        </Box>
      </Box>
    )
  }

  if (item.kind === 'context') {
    return (
      <Box>
        <Text dimColor>  {clipTextForDisplay(item.text)}</Text>
      </Box>
    )
  }

  return (
    <Box marginTop={1}>
      <Text color={color} bold>{label}</Text>
      <Box marginLeft={1} flexDirection="column" flexShrink={1}>
        <MarkdownText text={clipTextForDisplay(item.text)} dim />
      </Box>
    </Box>
  )
}

function StartupDuckBanner({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n')
  const duckLines = lines.slice(0, 5)
  const detailLines = lines.slice(5)

  return (
    <Box marginTop={1} marginBottom={1} flexDirection="column">
      <Box borderStyle="round" borderColor={animeTheme.duck} paddingX={1} flexDirection="column">
        {duckLines.map((line, index) => (
          <Text key={index} color={index === 3 ? animeTheme.mint : animeTheme.duck} bold={index === 3}>
            {line}
          </Text>
        ))}
        {detailLines.map((line, index) => (
          <Text key={`detail-${index}`} color={animeTheme.textDim}>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
