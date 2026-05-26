/**
 * 基于 `marked` 的轻量 Markdown 解析：产出 TUI 可渲染的块结构（非完整 HTML）。
 */
import { Lexer, lexer, type Token, type Tokens } from 'marked'

/** TUI 支持的 Markdown 块联合类型。 */
export type MarkdownBlock =
  | { type: 'heading'; depth: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | {
      type: 'table'
      headers: string[]
      rows: string[][]
      alignments: TableAlignment[]
      omittedRows?: number
    }
  | { type: 'quote'; text: string }
  | { type: 'code'; language?: string; code: string }
  | { type: 'rule' }

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
  return renderInlineTokens(Lexer.lexInline(text, { gfm: true, breaks: false }))
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
      return { type: 'heading', depth: token.depth, text: renderInlineTokens(token.tokens ?? []) }
    case 'paragraph':
      return { type: 'paragraph', text: renderInlineTokens(token.tokens ?? []) }
    case 'text':
      return { type: 'paragraph', text: renderInlineTokens(token.tokens ?? [token]) }
    case 'blockquote':
      return { type: 'quote', text: renderBlocksAsText(tokensToBlocks(token.tokens ?? [])) }
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
      return token.text.trim() ? { type: 'paragraph', text: token.text.trim() } : null
    default:
      return tokenHasInlineTokens(token) ? { type: 'paragraph', text: renderInlineTokens(token.tokens) } : null
  }
}

function tableTokenToBlock(token: Tokens.Table): MarkdownBlock {
  const rows = token.rows.slice(0, MAX_MARKDOWN_TABLE_ROWS)
  const omittedRows = Math.max(0, token.rows.length - rows.length)

  return {
    type: 'table',
    headers: token.header.map(renderTableCell),
    rows: rows.map((row) => row.map(renderTableCell)),
    alignments: token.align.map((alignment) => alignment ?? 'left'),
    ...(omittedRows > 0 ? { omittedRows } : {})
  }
}

function renderTableCell(cell: Tokens.TableCell): string {
  return renderInlineTokens(cell.tokens).trim()
}

function renderListItem(item: Tokens.ListItem): string {
  const blocks = tokensToBlocks(item.tokens)
  const text = renderBlocksAsText(blocks)
  const checkbox = item.task ? `${item.checked ? '[x]' : '[ ]'} ` : ''
  return `${checkbox}${text}`.trim()
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
      return block.items.join('\n')
    case 'table':
      return [block.headers.join(' | '), ...block.rows.map((row) => row.join(' | '))].join('\n')
    case 'code':
      return block.code
    case 'rule':
      return ''
  }
}

function renderInlineTokens(tokens: Token[]): string {
  return tokens.map(renderInlineToken).join('')
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'escape':
    case 'codespan':
      return token.text
    case 'strong':
    case 'em':
    case 'del':
      if (!token.tokens) return token.text
      return renderInlineTokens(token.tokens)
    case 'link': {
      const label = token.tokens ? renderInlineTokens(token.tokens) || token.text : token.text
      return token.href ? `${label} (${token.href})` : label
    }
    case 'image':
      return token.href ? `${token.text} (${token.href})` : token.text
    case 'br':
      return '\n'
    case 'html':
      return token.text
    default:
      if (tokenHasInlineTokens(token)) return renderInlineTokens(token.tokens)
      return 'text' in token && typeof token.text === 'string' ? token.text : ''
  }
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
