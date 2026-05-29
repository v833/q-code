/**
 * 将 Markdown 解析为 Ink 块级组件；流式模式下折叠过长内容。
 */
import React, { useMemo } from 'react'
import { Box, Text, useStdout } from 'ink'
import { parseMarkdown, type MarkdownBlock } from '../markdown'
import {
  computeMarkdownTableColumnWidths,
  renderMarkdownTable
} from '../table-renderer'
import {
  formatFileRefParts,
  renderInlineSegmentsAnsi,
  renderInlineSegmentsPlain,
  resolveInlinePalette,
  type InlinePalette,
  type MarkdownInlineSegment,
  type StatusTone
} from '../utils/markdown-inline'
import {
  clipDisplayWidth,
  clipDisplayWidthStart,
  stringDisplayWidth
} from '../utils/string-width'
import { rgbToInkColor } from '../utils/ansi-style'
import {
  highlightCode,
  isNoColorEnabled,
  resolveHighlightThemeMode
} from '../utils/highlight'

/** 超过此长度则跳过 Markdown 解析，直接纯文本渲染。 */
export const MARKDOWN_PARSE_CHAR_LIMIT = 12000
const STREAMING_MAX_CHARS = 2600
const STREAMING_RESERVED_ROWS = 8
const STREAMING_FALLBACK_ROWS = 16

/** 块级 Markdown 渲染；`streaming` 时启用行/字符折叠预览。 */
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
  const inlinePalette = resolveInlinePalette(resolveHighlightThemeMode())
  switch (block.type) {
    case 'heading':
      return (
        <Text bold color={rgbToInkColor(block.depth <= 2 ? inlinePalette.strong : inlinePalette.emphasis)}>
          <InlineMarkdownText segments={block.segments} dim={dim} strong palette={inlinePalette} />
        </Text>
      )
    case 'paragraph':
      return <InlineMarkdownText segments={block.segments} dim={dim} palette={inlinePalette} />
    case 'quote':
      return (
        <Text color={rgbToInkColor(inlinePalette.muted)}>
          │ <InlineMarkdownText segments={block.segments} dim={dim} palette={inlinePalette} />
        </Text>
      )
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            <Text key={index} dimColor={dim}>
              {block.ordered ? `${index + 1}.` : '•'} <InlineMarkdownText segments={item.segments} dim={dim} palette={inlinePalette} />
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

function InlineMarkdownText({
  segments,
  dim,
  strong = false,
  palette
}: {
  segments: readonly MarkdownInlineSegment[]
  dim: boolean
  strong?: boolean
  palette: InlinePalette
}): React.JSX.Element {
  return (
    <Text dimColor={dim} bold={strong}>
      {segments.map((segment, index) => (
        <InlineSegmentText key={index} segment={segment} dim={dim} palette={palette} />
      ))}
    </Text>
  )
}

function InlineSegmentText({
  segment,
  dim,
  palette
}: {
  segment: MarkdownInlineSegment
  dim: boolean
  palette: InlinePalette
}): React.JSX.Element {
  switch (segment.type) {
    case 'text':
      return <Text dimColor={dim}>{segment.text}</Text>
    case 'strong':
      return (
        <Text bold color={rgbToInkColor(palette.strong)}>
          {segment.segments.map((child, index) => (
            <InlineSegmentText key={index} segment={child} dim={false} palette={palette} />
          ))}
        </Text>
      )
    case 'emphasis':
      return (
        <Text italic color={rgbToInkColor(palette.emphasis)}>
          {segment.segments.map((child, index) => (
            <InlineSegmentText key={index} segment={child} dim={false} palette={palette} />
          ))}
        </Text>
      )
    case 'inlineCode':
      return <Text color={rgbToInkColor(palette.inlineCode)}>{segment.text}</Text>
    case 'link':
      return (
        <Text>
          <Text color={rgbToInkColor(palette.link)} underline>
            {segment.text}
          </Text>
          <Text color={rgbToInkColor(palette.muted)}> ({segment.href})</Text>
        </Text>
      )
    case 'url':
      return (
        <Text color={rgbToInkColor(palette.link)} underline>
          {segment.text}
        </Text>
      )
    case 'fileRef':
      return <FileRefText segment={segment} palette={palette} />
    case 'issueRef':
      return <Text color={rgbToInkColor(palette.issue)}>{segment.text}</Text>
    case 'status':
      return <Text bold color={rgbToInkColor(statusToneColor(segment.tone, palette))}>{segment.text}</Text>
    case 'envVar':
      return <Text color={rgbToInkColor(palette.inlineCode)}>{segment.text}</Text>
    case 'command':
      return <Text bold color={rgbToInkColor(palette.command)}>{segment.text}</Text>
  }
}

function FileRefText({
  segment,
  palette
}: {
  segment: Extract<MarkdownInlineSegment, { type: 'fileRef' }>
  palette: InlinePalette
}): React.JSX.Element {
  const parts = formatFileRefParts(segment)
  return (
    <Text>
      {parts.label ? (
        <>
          <Text color={rgbToInkColor(palette.link)} underline>{parts.label}</Text>
          <Text color={rgbToInkColor(palette.muted)}> (</Text>
        </>
      ) : null}
      <Text color={rgbToInkColor(palette.filePath)}>{parts.path}</Text>
      {parts.suffix ? <Text color={rgbToInkColor(palette.lineNumber)}>{parts.suffix}</Text> : null}
      {parts.label ? <Text color={rgbToInkColor(palette.muted)}>)</Text> : null}
    </Text>
  )
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
  const widths = computeMarkdownTableColumnWidths(block)
  const noColor = isNoColorEnabled()
  const themeMode = resolveHighlightThemeMode()

  return (
    <Box flexDirection="column" marginY={1} flexShrink={1}>
      <Text dimColor>{table.top}</Text>
      <Text bold wrap="truncate-end">
        {renderSemanticTableRow(block.headerSegments, block.headers, widths, block.alignments, noColor, themeMode)}
      </Text>
      <Text dimColor>{table.separator}</Text>
      {block.rowSegments.map((row, index) => (
        <Text key={index} dimColor={dim} wrap="truncate-end">
          {renderSemanticTableRow(row, block.rows[index] ?? [], widths, block.alignments, noColor, themeMode)}
        </Text>
      ))}
      {table.omitted ? <Text dimColor>{table.omitted}</Text> : null}
      <Text dimColor>{table.bottom}</Text>
    </Box>
  )
}

function renderSemanticTableRow(
  rowSegments: readonly (readonly MarkdownInlineSegment[])[],
  plainCells: readonly string[],
  widths: readonly number[],
  alignments: readonly string[],
  noColor: boolean,
  theme: ReturnType<typeof resolveHighlightThemeMode>
): string {
  return `│${widths
    .map((width, index) => {
      const plain = plainCells[index] ?? ''
      const segments = rowSegments[index] ?? [{ type: 'text' as const, text: plain }]
      const cellPlain = renderInlineSegmentsPlain(segments)
      const styled = renderStyledTableCell(segments, plain, width, noColor, theme)
      return ` ${alignStyledCell(styled, stringDisplayWidth(plain) > width ? clipDisplayWidth(plain, width) : cellPlain, width, alignments[index] ?? 'left')} `
    })
    .join('│')}│`
}

function renderStyledTableCell(
  segments: readonly MarkdownInlineSegment[],
  plain: string,
  width: number,
  noColor: boolean,
  theme: ReturnType<typeof resolveHighlightThemeMode>
): string {
  if (stringDisplayWidth(plain) <= width) return renderInlineSegmentsAnsi(segments, { noColor, theme })
  if (segments.length === 1 && segments[0]?.type === 'fileRef') {
    return renderClippedFileRefTableCell(segments[0], width, noColor, theme)
  }
  return clipDisplayWidth(plain, width)
}

function renderClippedFileRefTableCell(
  segment: Extract<MarkdownInlineSegment, { type: 'fileRef' }>,
  width: number,
  noColor: boolean,
  theme: ReturnType<typeof resolveHighlightThemeMode>
): string {
  const clipped = clipDisplayWidthStart(segment.text, width)
  if (noColor) return clipped
  const suffix = [
    segment.line !== undefined ? `:${segment.line}` : '',
    segment.column !== undefined ? `:${segment.column}` : ''
  ].join('')
  const clippedSegment: Extract<MarkdownInlineSegment, { type: 'fileRef' }> = suffix && clipped.endsWith(suffix)
    ? { type: 'fileRef', text: clipped, path: clipped.slice(0, -suffix.length), line: segment.line, column: segment.column }
    : { type: 'fileRef', text: clipped, path: clipped }
  return renderInlineSegmentsAnsi([clippedSegment], { theme })
}

function statusToneColor(tone: StatusTone, palette: InlinePalette) {
  if (tone === 'success') return palette.success
  if (tone === 'warning') return palette.warning
  return palette.error
}

function alignStyledCell(styled: string, plain: string, width: number, alignment: string): string {
  const contentWidth = Math.min(stringDisplayWidth(plain), width)
  const padding = Math.max(0, width - contentWidth)
  if (alignment === 'right') return `${' '.repeat(padding)}${styled}`
  if (alignment === 'center') {
    const left = Math.floor(padding / 2)
    return `${' '.repeat(left)}${styled}${' '.repeat(padding - left)}`
  }
  return `${styled}${' '.repeat(padding)}`
}

/** 是否应对文本执行 {@link parseMarkdown}。 */
export function shouldParseMarkdownText(text: string, parse = true): boolean {
  return parse && text.length <= MARKDOWN_PARSE_CHAR_LIMIT
}

/** 流式 assistant 文本的行/字符折叠预览。 */
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
