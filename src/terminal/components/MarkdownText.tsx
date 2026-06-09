/**
 * 将 Markdown 解析为 Ink 块级组件；流式模式下只格式化稳定前缀。
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
const BLANK_LINE_PATTERN = /\n[ \t]*(?:\n[ \t]*)+/g

interface StableMarkdownParts {
  stable: string
  tail: string
}

export interface StreamingMarkdownRenderParts {
  stableText: string
  stableBlocks: MarkdownBlock[]
  tailText: string
}

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
  if (!parse) return <Text dimColor={dim}>{displayText}</Text>
  if (streaming) return <StreamingMarkdownText text={displayText} dim={dim} />
  return <MarkdownBlocksText text={displayText} dim={dim} parse={parse} />
}

const MarkdownBlocksText = React.memo(function MarkdownBlocksText({
  text,
  dim,
  parse
}: {
  text: string
  dim: boolean
  parse: boolean
}): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdownBlocksSafe(text, parse), [text, parse])

  return <MarkdownBlocksView text={text} blocks={blocks} dim={dim} />
})

function MarkdownBlocksView({
  text,
  blocks,
  dim
}: {
  text: string
  blocks: MarkdownBlock[]
  dim: boolean
}): React.JSX.Element {
  if (blocks.length === 0) return <Text dimColor={dim}>{text}</Text>
  return (
    <Box flexDirection="column" flexShrink={1}>
      {blocks.map((block, index) => (
        <MarkdownBlockView key={index} block={block} dim={dim} />
      ))}
    </Box>
  )
}

function StreamingMarkdownText({
  text,
  dim
}: {
  text: string
  dim: boolean
}): React.JSX.Element {
  const { stableText, stableBlocks, tailText } = useMemo(() => prepareStreamingMarkdownRenderParts(text), [text])
  if (!stableText) return <Text dimColor={dim}>{tailText}</Text>
  return (
    <Box flexDirection="column" flexShrink={1}>
      <MarkdownBlocksView text={stableText} blocks={stableBlocks} dim={dim} />
      {tailText ? <Text dimColor={dim}>{tailText}</Text> : null}
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

/** 生成流式 Markdown 渲染计划：稳定前缀可解析，尾巴保持纯文本。 */
export function prepareStreamingMarkdownRenderParts(
  text: string,
  parse = true
): StreamingMarkdownRenderParts {
  const { stable, tail } = splitStableMarkdownPrefix(text)
  return {
    stableText: stable,
    stableBlocks: parseMarkdownBlocksSafe(stable, parse),
    tailText: tail
  }
}

/** 将流式 Markdown 拆为可安全格式化的稳定前缀和纯文本尾巴。 */
export function splitStableMarkdownPrefix(content: string): StableMarkdownParts {
  const normalized = normalizeStreamingText(content)
  const fences = scanFencedCodeBoundaries(normalized)
  const boundary = fences.unclosedStart === undefined
    ? latestStableBoundary(
        findLastBlankLineBoundary(normalized),
        fences.lastClosedBoundary
      )
    : findLastBlankLineBoundary(normalized, fences.unclosedStart)

  if (!boundary) return { stable: '', tail: normalized }

  return retreatUnstableInlineTail({
    stable: normalized.slice(0, boundary.stableEnd),
    tail: normalized.slice(boundary.tailStart)
  })
}

function parseMarkdownBlocksSafe(text: string, parse: boolean): MarkdownBlock[] {
  if (!shouldParseMarkdownText(text, parse)) return []
  try {
    return parseMarkdown(text)
  } catch {
    return []
  }
}

/** 流式 assistant 文本的行/字符折叠预览。 */
export function previewStreamingText(text: string, maxLines: number): string {
  const normalized = normalizeStreamingText(text)
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

function normalizeStreamingText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function findLastBlankLineBoundary(
  text: string,
  beforeIndex = text.length
): { stableEnd: number; tailStart: number } | null {
  const prefix = text.slice(0, beforeIndex)
  let last: { stableEnd: number; tailStart: number } | null = null
  for (const match of prefix.matchAll(BLANK_LINE_PATTERN)) {
    last = {
      stableEnd: match.index,
      tailStart: match.index + match[0].length
    }
  }
  return last
}

function scanFencedCodeBoundaries(text: string): {
  unclosedStart?: number
  lastClosedBoundary: { stableEnd: number; tailStart: number } | null
} {
  let openFence: { marker: '`' | '~'; length: number; start: number } | undefined
  let lastClosedBoundary: { stableEnd: number; tailStart: number } | null = null

  for (const line of iterateMarkdownLines(text)) {
    const fence = parseFenceLine(line.text, line.start)
    if (!fence) continue

    if (!openFence) {
      if (isOpeningFence(fence)) openFence = { marker: fence.marker, length: fence.length, start: fence.start }
      continue
    }

    if (isClosingFence(fence, openFence)) {
      lastClosedBoundary = { stableEnd: line.end, tailStart: line.nextStart }
      openFence = undefined
    }
  }

  return { unclosedStart: openFence?.start, lastClosedBoundary }
}

function stripClosedFencedCodeBlocks(text: string): string {
  let openFence: { marker: '`' | '~'; length: number; start: number } | undefined
  const outsideLines: string[] = []

  for (const line of iterateMarkdownLines(text)) {
    const fence = parseFenceLine(line.text, line.start)
    if (!openFence) {
      if (fence && isOpeningFence(fence)) {
        openFence = { marker: fence.marker, length: fence.length, start: fence.start }
      } else {
        outsideLines.push(line.text)
      }
      continue
    }

    if (fence && isClosingFence(fence, openFence)) {
      openFence = undefined
    }
  }

  return outsideLines.join('\n')
}

function iterateMarkdownLines(text: string): Array<{
  text: string
  start: number
  end: number
  nextStart: number
}> {
  const lines: Array<{ text: string; start: number; end: number; nextStart: number }> = []
  let start = 0
  while (start <= text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    lines.push({
      text: text.slice(start, end),
      start,
      end,
      nextStart: newline === -1 ? text.length : newline + 1
    })
    if (newline === -1) break
    start = newline + 1
  }
  return lines
}

function parseFenceLine(line: string, lineStart: number): {
  marker: '`' | '~'
  length: number
  rest: string
  start: number
} | null {
  const indent = line.match(/^[ \t]{0,3}/)?.[0] ?? ''
  const markerRun = line.slice(indent.length).match(/^(`{3,}|~{3,})/)?.[0]
  if (!markerRun) return null
  const marker = markerRun[0]
  if (marker !== '`' && marker !== '~') return null
  return {
    marker,
    length: markerRun.length,
    rest: line.slice(indent.length + markerRun.length),
    start: lineStart + indent.length
  }
}

function isOpeningFence(fence: {
  marker: '`' | '~'
  rest: string
}): boolean {
  return fence.marker === '~' || !fence.rest.includes('`')
}

function isClosingFence(
  fence: { marker: '`' | '~'; length: number; rest: string },
  openFence: { marker: '`' | '~'; length: number }
): boolean {
  return fence.marker === openFence.marker && fence.length >= openFence.length && fence.rest.trim() === ''
}

function latestStableBoundary(
  first: { stableEnd: number; tailStart: number } | null,
  second: { stableEnd: number; tailStart: number } | null
): { stableEnd: number; tailStart: number } | null {
  if (!first) return second
  if (!second) return first
  return second.stableEnd > first.stableEnd ? second : first
}

function retreatUnstableInlineTail(parts: StableMarkdownParts): StableMarkdownParts {
  let stable = parts.stable
  let tail = parts.tail

  while (stable && hasUnclosedInlineMarkdown(lastMarkdownParagraph(stable))) {
    const boundary = findLastBlankLineBoundary(stable)
    if (!boundary) {
      return { stable: '', tail: joinTail(stable, tail) }
    }
    const moved = stable.slice(boundary.tailStart)
    stable = stable.slice(0, boundary.stableEnd)
    tail = joinTail(moved, tail)
  }

  return { stable, tail }
}

function lastMarkdownParagraph(text: string): string {
  const boundary = findLastBlankLineBoundary(text)
  return boundary ? text.slice(boundary.tailStart) : text
}

function joinTail(prefix: string, tail: string): string {
  if (!prefix) return tail
  if (!tail) return prefix
  return `${prefix}\n\n${tail}`
}

function hasUnclosedInlineMarkdown(text: string): boolean {
  const inlineText = stripClosedFencedCodeBlocks(text)
  return (
    hasUnpairedInlineBacktick(inlineText) ||
    countUnescapedDelimiter(inlineText, '**') % 2 === 1 ||
    countUnescapedDelimiter(inlineText, '__') % 2 === 1
  )
}

function hasUnpairedInlineBacktick(text: string): boolean {
  const runCounts = new Map<number, number>()
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '`' || isEscapedAt(text, index)) continue
    let end = index + 1
    while (text[end] === '`') end++
    const length = end - index
    if (length < 3) runCounts.set(length, (runCounts.get(length) ?? 0) + 1)
    index = end - 1
  }
  return Array.from(runCounts.values()).some((count) => count % 2 === 1)
}

function countUnescapedDelimiter(text: string, delimiter: '**' | '__'): number {
  let count = 0
  for (let index = 0; index < text.length; index++) {
    if (!text.startsWith(delimiter, index) || isEscapedAt(text, index)) continue
    count++
    index += delimiter.length - 1
  }
  return count
}

function isEscapedAt(text: string, index: number): boolean {
  let slashCount = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashCount++
  return slashCount % 2 === 1
}
