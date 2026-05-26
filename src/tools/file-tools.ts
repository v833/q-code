/**
 * 文件读写工具：read_file、write_file、list_directory、edit_file（受 path-policy 约束）。
 */
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ToolDefinition, ToolExecutionContext } from './registry'
import { resolveToolPath } from './path-policy'
import { writeTextAtomic } from '../utils/atomic-write'

const DEFAULT_READ_MAX_LINES = 500
const MAX_READ_MAX_LINES = 2000
const DEFAULT_READ_MAX_CHARS = 20000
const MAX_READ_MAX_CHARS = 100000
const LARGE_FILE_BYTES = 1024 * 1024

interface ReadFileInput {
  path: string
  startLine?: number
  endLine?: number
  maxLines?: number
  maxChars?: number
  showLineNumbers?: boolean
}

/** 按行范围读取文本文件。 */
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    '按行范围读取指定路径的文本文件。默认读取前 500 行；读取大文件时请用 startLine/endLine 或 maxLines 分段查看',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      startLine: { type: 'integer', minimum: 1, description: '起始行号，从 1 开始，默认 1' },
      endLine: {
        type: 'integer',
        minimum: 1,
        description: '结束行号，包含该行。若不传，则按 maxLines 计算'
      },
      maxLines: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_READ_MAX_LINES,
        description: `最多返回多少行，默认 ${DEFAULT_READ_MAX_LINES}，最大 ${MAX_READ_MAX_LINES}`
      },
      maxChars: {
        type: 'integer',
        minimum: 1000,
        maximum: MAX_READ_MAX_CHARS,
        description: `最多返回多少字符，默认 ${DEFAULT_READ_MAX_CHARS}，最大 ${MAX_READ_MAX_CHARS}`
      },
      showLineNumbers: {
        type: 'boolean',
        description: '是否在正文前显示行号。默认 false；需要复制内容用于 edit_file 时不要开启'
      }
    },
    required: ['path'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  contextCost: 'high',
  resultShape: 'file',
  jitHint: '先定位行号或范围，再分段读取',
  maxResultChars: MAX_READ_MAX_CHARS + 2000,
  execute: async (input: ReadFileInput, context: ToolExecutionContext) => {
    try {
      return await readFileRange(input, context)
    } catch (err) {
      return { ok: false, error: `读取失败: ${err instanceof Error ? err.message : err}` }
    }
  }
}

async function readFileRange(input: ReadFileInput, context: ToolExecutionContext): Promise<string> {
  const resolved = resolveToolPath(context.cwd, input.path)
  if (!existsSync(resolved)) return `文件不存在: ${input.path}`

  const stat = statSync(resolved)
  if (stat.isDirectory()) return `路径是目录，不是文件: ${input.path}`
  if (looksLikeBinaryFile(resolved, stat.size)) {
    return `文件看起来是二进制内容，已拒绝按文本读取: ${input.path} (${formatBytes(stat.size)})`
  }

  const startLine = normalizePositiveInteger(input.startLine, 1, 'startLine')
  const maxLines = normalizePositiveInteger(input.maxLines, DEFAULT_READ_MAX_LINES, 'maxLines')
  const maxChars = normalizePositiveInteger(input.maxChars, DEFAULT_READ_MAX_CHARS, 'maxChars')
  const cappedMaxLines = Math.min(maxLines, MAX_READ_MAX_LINES)
  const cappedMaxChars = Math.min(maxChars, MAX_READ_MAX_CHARS)
  const showLineNumbers = input.showLineNumbers === true
  const requestedEndLine = input.endLine !== undefined
    ? normalizePositiveInteger(input.endLine, startLine + cappedMaxLines - 1, 'endLine')
    : startLine + cappedMaxLines - 1
  const endLine = Math.min(requestedEndLine, startLine + MAX_READ_MAX_LINES - 1)

  if (endLine < startLine) {
    return `参数错误: endLine (${endLine}) 不能小于 startLine (${startLine})`
  }

  const result =
    stat.size <= LARGE_FILE_BYTES
      ? readSmallFileRange(resolved, startLine, endLine, cappedMaxChars, showLineNumbers)
      : await readLargeFileRange(resolved, startLine, endLine, cappedMaxChars, showLineNumbers)

  const notices: string[] = []
  if (stat.size > LARGE_FILE_BYTES) {
    notices.push('文件较大，已按范围读取，未扫描全文统计总行数；建议用 startLine/endLine 分段读取或用 grep 定位')
  }
  if (maxLines > MAX_READ_MAX_LINES) {
    notices.push(`maxLines 已从 ${maxLines} 限制为 ${MAX_READ_MAX_LINES}`)
  }
  if (requestedEndLine > endLine) {
    notices.push(`请求结束行 ${requestedEndLine} 超过单次读取上限，实际读取到 ${endLine}`)
  }
  if (maxChars > MAX_READ_MAX_CHARS) {
    notices.push(`maxChars 已从 ${maxChars} 限制为 ${MAX_READ_MAX_CHARS}`)
  }
  if (result.truncatedByChars) {
    notices.push('返回内容达到 maxChars 限制，当前范围内仍有内容未显示')
  }
  if (result.hasMoreAfterRange) {
    notices.push(`后续可继续读取 startLine=${result.nextStartLine}`)
  }

  return [
    `[read_file] ${resolved}`,
    `大小: ${formatBytes(stat.size)} (${stat.size} bytes)`,
    `总行数: ${result.totalLines ?? '未知（大文件范围读取未扫描全文）'}`,
    `请求范围: ${startLine}-${requestedEndLine}`,
    `实际读取范围: ${startLine}-${endLine}`,
    `返回范围: ${result.firstReturnedLine ?? '无'}-${result.lastReturnedLine ?? '无'}`,
    `返回行数: ${result.returnedLineCount}`,
    `截断: ${result.truncated ? '是' : '否'}`,
    `行号: ${showLineNumbers ? '显示' : '隐藏（正文为原始内容）'}`,
    notices.length ? `提示: ${notices.join('；')}` : null,
    '',
    '内容:',
    result.lines.length ? result.lines.join('\n') : '(指定范围内没有内容)'
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

interface ReadRangeResult {
  lines: string[]
  totalLines?: number
  firstReturnedLine?: number
  lastReturnedLine?: number
  returnedLineCount: number
  nextStartLine: number
  hasMoreAfterRange: boolean
  truncated: boolean
  truncatedByChars: boolean
}

function readSmallFileRange(
  resolved: string,
  startLine: number,
  endLine: number,
  maxChars: number,
  showLineNumbers: boolean
): ReadRangeResult {
  const content = readFileSync(resolved, 'utf-8')
  const allLines = splitLines(content)
  const selected = allLines.slice(startLine - 1, Math.min(endLine, allLines.length))
  const { lines, lastReturnedLine, truncatedByChars } = renderLines(
    selected,
    startLine,
    maxChars,
    showLineNumbers
  )
  const hasMoreAfterRange = endLine < allLines.length || truncatedByChars
  const firstReturnedLine = lines.length > 0 ? startLine : undefined

  return {
    lines,
    totalLines: allLines.length,
    firstReturnedLine,
    lastReturnedLine,
    returnedLineCount: lines.length,
    nextStartLine: (lastReturnedLine ?? endLine) + 1,
    hasMoreAfterRange,
    truncated: startLine > 1 || hasMoreAfterRange || truncatedByChars,
    truncatedByChars
  }
}

async function readLargeFileRange(
  resolved: string,
  startLine: number,
  endLine: number,
  maxChars: number,
  showLineNumbers: boolean
): Promise<ReadRangeResult> {
  const rl = createInterface({
    input: createReadStream(resolved, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  const lines: string[] = []
  let lineNo = 0
  let usedChars = 0
  let truncatedByChars = false
  let firstReturnedLine: number | undefined
  let lastReturnedLine: number | undefined
  let stoppedBeforeEof = false

  for await (const line of rl) {
    lineNo++
    if (lineNo < startLine) continue
    if (lineNo > endLine) {
      stoppedBeforeEof = true
      break
    }

    const appended = appendRenderedLine(lines, line, lineNo, maxChars, usedChars, showLineNumbers)
    if (!appended.added) {
      truncatedByChars = true
      break
    }

    usedChars = appended.usedChars
    firstReturnedLine ??= lineNo
    lastReturnedLine = lineNo
    if (appended.truncatedByChars) {
      truncatedByChars = true
      break
    }
  }
  rl.close()

  const totalLines = stoppedBeforeEof || truncatedByChars ? undefined : lineNo

  return {
    lines,
    totalLines,
    firstReturnedLine,
    lastReturnedLine,
    returnedLineCount: lines.length,
    nextStartLine: (lastReturnedLine ?? endLine) + 1,
    hasMoreAfterRange: stoppedBeforeEof || truncatedByChars,
    truncated: startLine > 1 || stoppedBeforeEof || truncatedByChars,
    truncatedByChars
  }
}

function renderLines(
  rawLines: string[],
  startLine: number,
  maxChars: number,
  showLineNumbers: boolean
): { lines: string[]; lastReturnedLine?: number; truncatedByChars: boolean } {
  const lines: string[] = []
  let usedChars = 0
  let truncatedByChars = false
  let lastReturnedLine: number | undefined

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = startLine + i
    const appended = appendRenderedLine(lines, rawLines[i], lineNo, maxChars, usedChars, showLineNumbers)
    if (!appended.added) {
      truncatedByChars = true
      break
    }

    usedChars = appended.usedChars
    lastReturnedLine = lineNo
    if (appended.truncatedByChars) {
      truncatedByChars = true
      break
    }
  }

  return { lines, lastReturnedLine, truncatedByChars }
}

function appendRenderedLine(
  lines: string[],
  rawLine: string,
  lineNo: number,
  maxChars: number,
  usedChars: number,
  showLineNumbers: boolean
): { added: boolean; usedChars: number; truncatedByChars: boolean } {
  const rendered = showLineNumbers ? `${String(lineNo).padStart(6, ' ')} | ${rawLine}` : rawLine
  const nextSize = rendered.length + 1

  if (usedChars + nextSize <= maxChars) {
    lines.push(rendered)
    return { added: true, usedChars: usedChars + nextSize, truncatedByChars: false }
  }

  const remaining = maxChars - usedChars
  if (remaining <= 30) {
    return { added: false, usedChars, truncatedByChars: true }
  }

  lines.push(`${rendered.slice(0, remaining - 18)} ...[行内截断]`)
  return { added: true, usedChars: maxChars, truncatedByChars: true }
}

function splitLines(content: string): string[] {
  if (!content) return []
  const lines = content.split(/\r\n|\n|\r/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function normalizePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function looksLikeBinaryFile(resolved: string, fileSize: number): boolean {
  if (fileSize === 0) return false

  const fd = openSync(resolved, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(8192, fileSize))
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    closeSync(fd)
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** 写入或覆盖文本文件。 */
export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '写入内容到指定文件',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容' }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  isConcurrencySafe: false, // 写操作不能并行
  isReadOnly: false,
  contextCost: 'high',
  resultShape: 'mutation',
  jitHint: '写入前确认目标路径和完整内容',
  execute: async ({ path, content }: { path: string; content: string }, context: ToolExecutionContext) => {
    try {
      await writeTextAtomic(resolveToolPath(context.cwd, path), content)
      return `已写入 ${content.length} 字符到 ${path}`
    } catch (err) {
      return { ok: false, error: `写入失败: ${err instanceof Error ? err.message : err}` }
    }
  }
}

/** 列出目录内容。 */
export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: '列出指定目录下的文件和子目录',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，默认为当前目录' }
    },
    required: [],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  contextCost: 'low',
  resultShape: 'paths',
  jitHint: '用于先看目录轮廓',
  execute: async ({ path = '.' }: { path?: string }, context: ToolExecutionContext) => {
    try {
      const resolved = resolveToolPath(context.cwd, path)
      return readdirSync(resolved)
        .map((name) => {
          const stat = statSync(join(resolved, name))
          return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}`
        })
        .join('\n')
    } catch (err) {
      return { ok: false, error: `列出目录失败: ${err instanceof Error ? err.message : err}` }
    }
  }
}

/** 对文件做基于搜索替换的编辑。 */
export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    '精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配）' },
      new_string: { type: 'string', description: '替换后的新文本' }
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  contextCost: 'high',
  resultShape: 'mutation',
  jitHint: '修改前先 read_file 获取精确上下文',
  execute: async ({ path, old_string, new_string }, context: ToolExecutionContext) => {
    let resolved: string
    try {
      resolved = resolveToolPath(context.cwd, path)
    } catch (err) {
      return { ok: false, error: `编辑失败: ${err instanceof Error ? err.message : err}` }
    }
    if (!existsSync(resolved)) return `文件不存在: ${path}`

    const content = readFileSync(resolved, 'utf-8')
    const count = content.split(old_string).length - 1

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`
    }

    const updated = content.replace(old_string, new_string)
    await writeTextAtomic(resolved, updated)
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`
  }
}
