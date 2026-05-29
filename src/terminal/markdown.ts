/**
 * 基于 `marked` 的轻量 Markdown 解析：产出 TUI 可渲染的块结构（非完整 HTML）。
 */
import { Lexer, lexer, type Token, type Tokens } from 'marked'
import {
  parseMarkdownInline,
  renderInlineSegmentsPlain,
  type MarkdownInlineSegment
} from './utils/markdown-inline'

/** TUI 支持的 Markdown 块联合类型。 */
export type MarkdownBlock =
  | { type: 'heading'; depth: number; text: string; segments: MarkdownInlineSegment[] }
  | { type: 'paragraph'; text: string; segments: MarkdownInlineSegment[] }
  | { type: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | {
      type: 'table'
      headers: string[]
      rows: string[][]
      headerSegments: MarkdownInlineSegment[][]
      rowSegments: MarkdownInlineSegment[][][]
      alignments: TableAlignment[]
      omittedRows?: number
    }
  | { type: 'quote'; text: string; segments: MarkdownInlineSegment[] }
  | { type: 'code'; language?: string; code: string }
  | { type: 'rule' }

/** Markdown 列表项：`text` 兼容旧渲染，`segments` 用于语义高亮。 */
export interface MarkdownListItem {
  text: string
  segments: MarkdownInlineSegment[]
}

/** GFM 表格列对齐方式。 */
export type TableAlignment = 'left' | 'center' | 'right'

/** 单表最大渲染行数，超出部分记入 `omittedRows`。 */
export const MAX_MARKDOWN_TABLE_ROWS = 300

/**
 * 将 Markdown 字符串解析为 {@link MarkdownBlock} 列表（启用 GFM）。
 */
export function parseMarkdown(markdown: string): MarkdownBlock[] {
  return tokensToBlocks(lexer(markdown, { gfm: true, breaks: false }))
}

/** 剥除行内 Markdown 标记，保留纯文本。 */
export function stripInlineMarkdown(text: string): string {
  return renderInlineSegmentsPlain(parseMarkdownInline(text))
}

function tokensToBlocks(tokens: Token[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []

  for (const token of tokens) {
    const block = tokenToBlock(token)
    if (block) blocks.push(block)
  }

  return blocks
}

function tokenToBlock(token: Token): MarkdownBlock | null {
  switch (token.type) {
    case 'space':
    case 'def':
      return null
    case 'heading':
      return createTextBlock('heading', token.tokens ?? [], token.depth)
    case 'paragraph':
      return createTextBlock('paragraph', token.tokens ?? [])
    case 'text':
      return createTextBlock('paragraph', token.tokens ?? [token])
    case 'blockquote':
      return createQuoteBlock(tokensToBlocks(token.tokens ?? []))
    case 'list':
      return {
        type: 'list',
        ordered: token.ordered,
        items: token.items.map((item: Tokens.ListItem) => renderListItem(item))
      }
    case 'table':
      if (!isTableToken(token)) return null
      return tableTokenToBlock(token)
    case 'code':
      return {
        type: 'code',
        ...(token.lang ? { language: token.lang.trim() } : {}),
        code: token.text
      }
    case 'hr':
      return { type: 'rule' }
    case 'html':
      return token.text.trim() ? createPlainTextBlock('paragraph', token.text.trim()) : null
    default:
      return tokenHasInlineTokens(token) ? createTextBlock('paragraph', token.tokens) : null
  }
}

function createTextBlock(
  type: 'heading',
  tokens: Token[],
  depth: number
): Extract<MarkdownBlock, { type: 'heading' }>
function createTextBlock(
  type: 'paragraph',
  tokens: Token[]
): Extract<MarkdownBlock, { type: 'paragraph' }>
function createTextBlock(type: 'heading' | 'paragraph', tokens: Token[], depth?: number): MarkdownBlock {
  const segments = parseInlineTokensCompat(tokens)
  const text = renderInlineSegmentsPlain(segments)
  return type === 'heading'
    ? { type, depth: depth ?? 1, text, segments }
    : { type, text, segments }
}

function createPlainTextBlock(
  type: 'paragraph' | 'quote',
  text: string
): Extract<MarkdownBlock, { type: 'paragraph' | 'quote' }> {
  const segments = parseMarkdownInline(text)
  return { type, text: renderInlineSegmentsPlain(segments), segments }
}

function createQuoteBlock(blocks: MarkdownBlock[]): Extract<MarkdownBlock, { type: 'quote' }> {
  const segments: MarkdownInlineSegment[] = []
  for (const [index, block] of blocks.entries()) {
    if (index > 0) segments.push({ type: 'text', text: '\n' })
    segments.push(...blockInlineSegments(block))
  }
  const text = renderInlineSegmentsPlain(segments).trim()
  return { type: 'quote', text, segments: trimTextSegmentEdges(segments) }
}

function tableTokenToBlock(token: Tokens.Table): MarkdownBlock {
  const rows = token.rows.slice(0, MAX_MARKDOWN_TABLE_ROWS)
  const omittedRows = Math.max(0, token.rows.length - rows.length)

  return {
    type: 'table',
    headers: token.header.map(renderTableCell),
    rows: rows.map((row) => row.map(renderTableCell)),
    headerSegments: token.header.map(renderTableCellSegments),
    rowSegments: rows.map((row) => row.map(renderTableCellSegments)),
    alignments: token.align.map((alignment) => alignment ?? 'left'),
    ...(omittedRows > 0 ? { omittedRows } : {})
  }
}

function renderTableCell(cell: Tokens.TableCell): string {
  return renderInlineSegmentsPlain(renderTableCellSegments(cell)).trim()
}

function renderTableCellSegments(cell: Tokens.TableCell): MarkdownInlineSegment[] {
  return parseInlineTokensCompat(cell.tokens)
}

function renderListItem(item: Tokens.ListItem): MarkdownListItem {
  const blocks = tokensToBlocks(item.tokens)
  const text = renderBlocksAsText(blocks)
  const checkbox = item.task ? `${item.checked ? '[x]' : '[ ]'} ` : ''
  const itemText = `${checkbox}${text}`.trim()
  const segments = [...(checkbox ? parseMarkdownInline(checkbox) : []), ...listItemInlineSegments(item)]
  return { text: itemText, segments: segments.length > 0 ? segments : parseMarkdownInline(itemText) }
}

function renderBlocksAsText(blocks: MarkdownBlock[]): string {
  return blocks.map(renderBlockAsText).filter(Boolean).join('\n').trim()
}

function renderBlockAsText(block: MarkdownBlock): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return block.text
    case 'list':
      return block.items.map((item) => item.text).join('\n')
    case 'table':
      return [block.headers.join(' | '), ...block.rows.map((row) => row.join(' | '))].join('\n')
    case 'code':
      return block.code
    case 'rule':
      return ''
  }
}

function blockInlineSegments(block: MarkdownBlock): MarkdownInlineSegment[] {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return block.segments
    case 'list':
      return joinSegmentLines(block.items.map((item) => item.segments))
    case 'table':
      return parseMarkdownInline(renderBlockAsText(block))
    case 'code':
      return [{ type: 'inlineCode', text: block.code }]
    case 'rule':
      return []
  }
}

function joinSegmentLines(lines: MarkdownInlineSegment[][]): MarkdownInlineSegment[] {
  return lines.flatMap((segments, index) => index === 0 ? segments : [{ type: 'text' as const, text: '\n' }, ...segments])
}

function trimTextSegmentEdges(segments: MarkdownInlineSegment[]): MarkdownInlineSegment[] {
  const trimmed = [...segments]
  while (trimmed[0]?.type === 'text' && trimmed[0].text.trim().length === 0) trimmed.shift()
  while (trimmed.at(-1)?.type === 'text' && trimmed.at(-1)?.text.trim().length === 0) trimmed.pop()
  const first = trimmed[0]
  if (first?.type === 'text') first.text = first.text.trimStart()
  const last = trimmed.at(-1)
  if (last?.type === 'text') last.text = last.text.trimEnd()
  return trimmed
}

function parseInlineTokensCompat(tokens: Token[]): MarkdownInlineSegment[] {
  return parseMarkdownInline(tokens.map(renderRawInlineToken).join(''))
}

function listItemInlineSegments(item: Tokens.ListItem): MarkdownInlineSegment[] {
  if (item.tokens.length === 1) {
    const [token] = item.tokens
    if (tokenHasInlineTokens(token)) return parseInlineTokensCompat(token.tokens)
    if ('text' in token && typeof token.text === 'string') return parseMarkdownInline(token.text)
  }
  return parseMarkdownInline(renderBlocksAsText(tokensToBlocks(item.tokens)))
}

function renderRawInlineToken(token: Token): string {
  return 'raw' in token && typeof token.raw === 'string'
    ? token.raw
    : 'text' in token && typeof token.text === 'string'
      ? token.text
      : ''
}

function isTableToken(token: Token): token is Tokens.Table {
  return (
    token.type === 'table' &&
    Array.isArray((token as Partial<Tokens.Table>).header) &&
    Array.isArray((token as Partial<Tokens.Table>).rows) &&
    Array.isArray((token as Partial<Tokens.Table>).align)
  )
}

function tokenHasInlineTokens(token: Token): token is Token & { tokens: Token[] } {
  return Array.isArray((token as { tokens?: unknown }).tokens)
}
