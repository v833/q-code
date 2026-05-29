/**
 * 将 {@link MarkdownBlock} 表格块格式化为带框线的等宽终端表格字符串。
 */
import type { MarkdownBlock, TableAlignment } from './markdown'
import {
  clipDisplayWidth,
  padDisplayCenter,
  padDisplayEnd,
  padDisplayStart,
  stringDisplayWidth
} from './utils/string-width'

/** 已格式化的表格各段文本（顶/头/分隔/行/底及省略提示）。 */
export type RenderedMarkdownTable = {
  top: string
  header: string
  separator: string
  rows: string[]
  bottom: string
  omitted?: string
}

const MIN_COLUMN_WIDTH = 3
const MAX_COLUMN_WIDTH = 64

/**
 * 按列宽与对齐方式渲染 GFM 表格块为 Unicode 框线表格。
 */
export function renderMarkdownTable(block: Extract<MarkdownBlock, { type: 'table' }>): RenderedMarkdownTable {
  const widths = computeMarkdownTableColumnWidths(block)
  return {
    top: renderBorder('top', widths),
    header: renderTableRow(block.headers, widths, block.alignments),
    separator: renderBorder('middle', widths),
    rows: block.rows.map((row) => renderTableRow(row, widths, block.alignments)),
    bottom: renderBorder('bottom', widths),
    ...(block.omittedRows ? { omitted: renderOmittedRow(block.omittedRows, widths) } : {})
  }
}

/** 计算 Markdown 表格列宽，供字符串表格和语义高亮表格共用。 */
export function computeMarkdownTableColumnWidths(block: Extract<MarkdownBlock, { type: 'table' }>): number[] {
  const columnCount = block.headers.length
  const widths = block.headers.map((cell) => stringDisplayWidth(cell))
  for (const row of block.rows) {
    for (let i = 0; i < columnCount; i++) {
      widths[i] = Math.max(widths[i] ?? 0, stringDisplayWidth(row[i] ?? ''))
    }
  }
  return widths.map((width) => Math.max(MIN_COLUMN_WIDTH, Math.min(width, MAX_COLUMN_WIDTH)))
}

function renderTableRow(cells: string[], widths: number[], alignments: TableAlignment[]): string {
  return `│${widths
    .map((width, index) => ` ${alignCell(cells[index] ?? '', width, alignments[index] ?? 'left')} `)
    .join('│')}│`
}

function renderBorder(kind: 'top' | 'middle' | 'bottom', widths: number[]): string {
  const chars = {
    top: ['┌', '┬', '┐'],
    middle: ['├', '┼', '┤'],
    bottom: ['└', '┴', '┘']
  }[kind]
  return `${chars[0]}${widths.map((width) => '─'.repeat(width + 2)).join(chars[1])}${chars[2]}`
}

function alignCell(text: string, width: number, alignment: TableAlignment): string {
  const clipped = clipDisplayWidth(text, width)
  if (alignment === 'right') return padDisplayStart(clipped, width)
  if (alignment === 'center') return padDisplayCenter(clipped, width)
  return padDisplayEnd(clipped, width)
}

function renderOmittedRow(omittedRows: number, widths: number[]): string {
  const innerWidth = widths.reduce((total, width) => total + width + 2, 0) + Math.max(0, widths.length - 1)
  return `│${padDisplayEnd(clipDisplayWidth(`... omitted ${omittedRows} rows while rendering ...`, innerWidth), innerWidth)}│`
}
