import React, { useMemo } from 'react'
import { Box, Text, useStdout } from 'ink'
import { parseMarkdown, type MarkdownBlock } from '../markdown'
import { renderMarkdownTable } from '../table-renderer'
import {
  highlightCode,
  isNoColorEnabled,
  resolveHighlightThemeMode
} from '../utils/highlight'

export const MARKDOWN_PARSE_CHAR_LIMIT = 12000
const STREAMING_MAX_CHARS = 2600
const STREAMING_RESERVED_ROWS = 8
const STREAMING_FALLBACK_ROWS = 16

export function MarkdownText({
  text,
  dim = false,
  parse = true,
  streaming = false
}: {
  text: string
  dim?: boolean
  parse?: boolean
  streaming?: boolean
}): React.JSX.Element {
  const { stdout } = useStdout()
  const maxStreamingLines = Math.max(
    8,
    Math.min(18, (stdout.rows ?? STREAMING_FALLBACK_ROWS + STREAMING_RESERVED_ROWS) - STREAMING_RESERVED_ROWS)
  )
  const displayText = streaming ? previewStreamingText(text, maxStreamingLines) : text
  const shouldParse = !streaming && shouldParseMarkdownText(displayText, parse)
  const blocks = useMemo(() => {
    if (!shouldParse) return []
    try {
      return parseMarkdown(displayText)
    } catch {
      return []
    }
  }, [displayText, shouldParse])
  if (!parse) return <Text dimColor={dim}>{text}</Text>
  if (blocks.length === 0) return <Text dimColor={dim}>{displayText}</Text>
  return (
    <Box flexDirection="column" flexShrink={1}>
      {blocks.map((block, index) => (
        <MarkdownBlockView key={index} block={block} dim={dim} />
      ))}
    </Box>
  )
}

function MarkdownBlockView({
  block,
  dim
}: {
  block: MarkdownBlock
  dim: boolean
}): React.JSX.Element {
  switch (block.type) {
    case 'heading':
      return (
        <Text bold color={block.depth <= 2 ? 'cyan' : 'blue'}>
          {block.text}
        </Text>
      )
    case 'paragraph':
      return <Text dimColor={dim}>{block.text}</Text>
    case 'quote':
      return <Text color="gray">│ {block.text}</Text>
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            <Text key={index} dimColor={dim}>
              {block.ordered ? `${index + 1}.` : '•'} {item}
            </Text>
          ))}
        </Box>
      )
    case 'table':
      return <MarkdownTable block={block} dim={dim} />
    case 'code':
      return (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="blue"
          paddingX={1}
          flexShrink={1}
        >
          {block.language ? <Text color="gray">{block.language}</Text> : null}
          <CodeBlockText code={block.code || ' '} language={block.language} />
        </Box>
      )
    case 'rule':
      return <Text dimColor>────────────────────────────────</Text>
  }
}

function CodeBlockText({
  code,
  language
}: {
  code: string
  language?: string
}): React.JSX.Element {
  const themeMode = resolveHighlightThemeMode()
  const noColor = isNoColorEnabled()
  const highlightedCode = useMemo(
    () => highlightCode(code, language, { theme: themeMode, noColor }),
    [code, language, themeMode, noColor]
  )

  if (noColor) {
    return <Text wrap="truncate-end">{code}</Text>
  }

  return <Text wrap="truncate-end">{highlightedCode}</Text>
}

function MarkdownTable({
  block,
  dim
}: {
  block: Extract<MarkdownBlock, { type: 'table' }>
  dim: boolean
}): React.JSX.Element {
  const table = renderMarkdownTable(block)

  return (
    <Box flexDirection="column" marginY={1} flexShrink={1}>
      <Text dimColor>{table.top}</Text>
      <Text color="cyan" bold wrap="truncate-end">{table.header}</Text>
      <Text dimColor>{table.separator}</Text>
      {table.rows.map((row, index) => (
        <Text key={index} dimColor={dim} wrap="truncate-end">
          {row}
        </Text>
      ))}
      {table.omitted ? <Text dimColor>{table.omitted}</Text> : null}
      <Text dimColor>{table.bottom}</Text>
    </Box>
  )
}

export function shouldParseMarkdownText(text: string, parse = true): boolean {
  return parse && text.length <= MARKDOWN_PARSE_CHAR_LIMIT
}

export function previewStreamingText(text: string, maxLines: number): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const charTrimmed =
    normalized.length > STREAMING_MAX_CHARS
      ? [
          `... 内容较长，已折叠 ${normalized.length - STREAMING_MAX_CHARS} 字符 ...`,
          '',
          normalized.slice(-STREAMING_MAX_CHARS)
        ].join('\n')
      : normalized
  const lines = charTrimmed.split('\n')
  if (lines.length <= maxLines) return charTrimmed

  const visibleLines = Math.max(1, maxLines - 2)
  const omitted = lines.length - visibleLines
  return [
    `... 内容较长，已折叠 ${omitted} 行 ...`,
    '',
    ...lines.slice(-visibleLines)
  ].join('\n')
}
