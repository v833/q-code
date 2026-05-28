/**
 * `@file` 文件引用：路径索引、fuzzy 补全、行/范围/正则选择器解析，以及安全读取与上下文注入。
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { isInsideDirectory } from '../tools/path-policy'
import { isTrueEnv } from '../utils/env'

/** 文件索引最多收录的相对路径数量。 */
export const FILE_MENTION_MAX_INDEX_FILES = 20_000
/** 单个 `@file` 附件的最大字节数。 */
export const FILE_MENTION_SINGLE_FILE_MAX_BYTES = 50 * 1024
/** 一轮用户消息中所有 `@file` 附件的合计字节上限。 */
export const FILE_MENTION_TOTAL_MAX_BYTES = 200 * 1024

const DEFAULT_SUGGESTION_LIMIT = 8
const READ_CHUNK_BYTES = 64 * 1024
const MAX_SELECTOR_SCAN_BYTES = 2 * 1024 * 1024
const MAX_REGEX_PATTERN_CHARS = 120
const MAX_REGEX_LINE_CHARS = 200
const INTERNAL_INDEX_SKIP_DIRS = new Set(['.q-code', '.sessions', '.playground', '.playwright-mcp'])
const FALLBACK_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'coverage',
  ...INTERNAL_INDEX_SKIP_DIRS
])
const GIT_LOCAL_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_WORK_TREE'
]

/** 文件索引的构建来源。 */
export type FileMentionIndexSource = 'git' | 'walk' | 'empty' | 'cache'

/** `@file` 补全用的 cwd 内相对路径索引。 */
export interface FileMentionIndex {
  cwd: string
  /** 已排序的相对路径列表（可能因 {@link FILE_MENTION_MAX_INDEX_FILES} 被裁剪）。 */
  files: string[]
  /** 索引构建时见到的文件总数（含被裁剪部分）。 */
  totalFiles: number
  /** 是否因上限未收录全部文件。 */
  truncated: boolean
  source: FileMentionIndexSource
  /** 缓存索引的原始构建来源。 */
  cachedSource?: Exclude<FileMentionIndexSource, 'cache' | 'empty'>
  /** 索引刷新完成时间。 */
  updatedAt?: string
  /** 索引构建失败时的说明。 */
  error?: string
  /** 索引仍可用但需要展示给用户的非阻塞提示。 */
  notice?: string
}

/** fuzzy 搜索单条候选及其得分。 */
export interface FileMentionSuggestion {
  path: string
  score: number
}

/** 输入框光标处正在编辑的 `@file` token 区间。 */
export interface FileMentionAtCursor {
  /** token 在输入串中的字素簇起点（含 `@`）。 */
  start: number
  /** token 在输入串中的字素簇终点（不含）。 */
  end: number
  /** 含 `@` 的完整 token 文本。 */
  token: string
  /** 用于 fuzzy 匹配的路径查询（已剥除行/范围/正则后缀）。 */
  query: string
}

/** 路径后的可选内容选择器（`:line`、`:start-end`、`: #regex`）。 */
export type FileMentionSelector =
  | { type: 'line'; line: number }
  | { type: 'range'; startLine: number; endLine: number }
  | { type: 'regex'; pattern: string }

/** 解析后的 `@file` 目标路径与可选选择器。 */
export interface ParsedFileMentionTarget {
  path: string
  selector?: FileMentionSelector
}

/** 单个 `@file` token 的读取与注入结果。 */
export interface FileMentionResult {
  raw: string
  path: string
  absolutePath?: string
  selector?: FileMentionSelector
  selectorLabel?: string
  status: 'included' | 'blocked' | 'missing' | 'binary' | 'dropped' | 'invalid'
  chars: number
  bytes: number
  truncated: boolean
  reason?: string
  content?: string
}

/** {@link expandFileMentions} 的完整输出：改写后的 prompt 与各 mention 明细。 */
export interface FileMentionExpansion {
  prompt: string
  results: FileMentionResult[]
  included: FileMentionResult[]
  warnings: string[]
  paths: string[]
  totalBytes: number
}

/** {@link expandFileMentions} 的路径策略与字节预算。 */
export interface ExpandFileMentionsOptions {
  cwd: string
  /** 是否允许绝对路径；默认读 `Q_CODE_MENTION_ALLOW_ABS`。 */
  allowAbsolute?: boolean
  singleFileMaxBytes?: number
  totalMaxBytes?: number
}

/**
 * 为 `cwd` 构建 `@file` 补全索引：优先 `git ls-files`，否则目录遍历。
 *
 * @param maxFiles - 最多收录路径数，默认 {@link FILE_MENTION_MAX_INDEX_FILES}。
 */
export async function createFileMentionIndex(
  cwd: string,
  maxFiles = FILE_MENTION_MAX_INDEX_FILES,
  options: { ignoreDirs?: Iterable<string> } = {}
): Promise<FileMentionIndex> {
  const root = resolve(cwd)
  const fromGit = await readGitFileIndex(root, maxFiles)
  if (fromGit) return fromGit
  return walkFileIndex(root, maxFiles, options.ignoreDirs)
}

/** 返回空索引（TUI 在索引尚未就绪时使用）。 */
export function createEmptyFileMentionIndex(cwd: string): FileMentionIndex {
  return {
    cwd: resolve(cwd),
    files: [],
    totalFiles: 0,
    truncated: false,
    source: 'empty'
  }
}

/**
 * 对索引做子序列 fuzzy 匹配并按得分降序返回候选。
 *
 * @param limit - 最多返回条数，默认 8。
 */
export function searchFileMentionIndex(
  index: FileMentionIndex,
  query: string,
  limit = DEFAULT_SUGGESTION_LIMIT
): FileMentionSuggestion[] {
  const normalizedQuery = normalizeQuery(query)
  const scored = index.files
    .map((path) => {
      const score = scoreFileMentionCandidate(normalizedQuery, path)
      return score === null ? null : { path, score }
    })
    .filter((item): item is FileMentionSuggestion => item !== null)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))

  return scored.slice(0, limit)
}

/**
 * 计算 query 与 candidatePath 的 fuzzy 得分；无法匹配时返回 `null`。
 *
 * 空 query 时按路径长度给予基础分，便于列出常用文件。
 */
export function scoreFileMentionCandidate(query: string, candidatePath: string): number | null {
  const candidate = normalizeQuery(candidatePath)
  if (!query) {
    return 20 - Math.min(candidate.length, 200) / 20
  }

  let score = 0
  let cursor = 0
  let lastMatch = -1
  for (const char of query) {
    const index = candidate.indexOf(char, cursor)
    if (index < 0) return null

    score += 8
    if (index === lastMatch + 1) score += 10
    if (index === 0 || isPathBoundary(candidate[index - 1])) score += 6
    cursor = index + 1
    lastMatch = index
  }

  const base = basename(candidate)
  if (candidate.includes(query)) score += 30
  if (base.startsWith(query)) score += 40
  if (candidate.startsWith(query)) score += 20
  score -= Math.min(candidate.length, 240) / 30
  return score
}

/** 从光标左侧回溯，定位正在编辑的 `@file` token（支持引号路径）。 */
export function findFileMentionAtCursor(value: string, cursor: number): FileMentionAtCursor | null {
  const chars = splitTextUnits(value)
  const safeCursor = Math.max(0, Math.min(chars.length, cursor))

  for (let start = safeCursor - 1; start >= 0; start--) {
    if (chars[start] !== '@') continue
    if (start > 0 && !isTokenBoundary(chars[start - 1] ?? '')) continue

    const quote = chars[start + 1]
    if (quote === '"' || quote === "'") {
      const closing = findClosingQuote(chars, start + 2, quote)
      if (closing >= 0 && safeCursor > closing + 1) return null
      const end = closing >= 0 ? closing + 1 : safeCursor
      const rawQuery = unescapeQuotedPath(chars.slice(start + 2, Math.min(safeCursor, end)).join(''))
      if (!rawQuery) return null
      return {
        start,
        end,
        token: chars.slice(start, end).join(''),
        query: stripSelectorFromQuery(rawQuery)
      }
    }

    if (chars.slice(start + 1, safeCursor).some(isTokenBoundary)) return null
    let end = safeCursor
    while (end < chars.length && !isTokenBoundary(chars[end] ?? '')) end++
    const token = chars.slice(start, end).join('')
    const rawQuery = token.slice(1)
    if (!rawQuery || rawQuery.startsWith('@')) return null
    return {
      start,
      end,
      token,
      query: stripSelectorFromQuery(rawQuery)
    }
  }

  return null
}

/**
 * 解析 `@file` 目标字符串中的路径与 `:line` / `:start-end` / `:#regex` 选择器。
 *
 * `:#` 后缀优先于单个 `:`，避免与 Windows 盘符冲突。
 */
export function parseFileMentionTarget(rawTarget: string): ParsedFileMentionTarget {
  const target = rawTarget.trim()
  const regexIndex = target.lastIndexOf(':#')
  if (regexIndex > 0) {
    const path = target.slice(0, regexIndex)
    const pattern = target.slice(regexIndex + 2)
    return pattern ? { path, selector: { type: 'regex', pattern } } : { path: target }
  }

  const colonIndex = target.lastIndexOf(':')
  if (colonIndex > 0) {
    const suffix = target.slice(colonIndex + 1)
    const singleLine = suffix.match(/^(\d+)$/)
    if (singleLine) {
      return {
        path: target.slice(0, colonIndex),
        selector: { type: 'line', line: Number(singleLine[1]) }
      }
    }

    const range = suffix.match(/^(\d+)-(\d+)$/)
    if (range) {
      return {
        path: target.slice(0, colonIndex),
        selector: {
          type: 'range',
          startLine: Number(range[1]),
          endLine: Number(range[2])
        }
      }
    }
  }

  return { path: target }
}

/** 从整段用户输入中提取所有 `@file` token 的原始目标字符串（去重保序）。 */
export function extractFileMentionTokens(input: string): string[] {
  const tokens: string[] = []
  const chars = splitTextUnits(input)
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] !== '@') continue
    if (index > 0 && !isTokenBoundary(chars[index - 1] ?? '')) continue

    const quote = chars[index + 1]
    if (quote === '"' || quote === "'") {
      const closing = findClosingQuote(chars, index + 2, quote)
      if (closing < 0) continue
      const raw = unescapeQuotedPath(chars.slice(index + 2, closing).join('').trim())
      if (raw) tokens.push(raw)
      index = closing
      continue
    }

    let end = index + 1
    while (end < chars.length && !isTokenBoundary(chars[end] ?? '')) end++
    const raw = trimMentionToken(chars.slice(index + 1, end).join('').trim())
    if (raw) tokens.push(raw)
    index = end
  }
  return tokens
}

/**
 * 展开输入中的 `@file` token：读取文件、校验 cwd/ symlink、应用字节预算并改写 prompt。
 *
 * 被 blocked/missing 的 mention 保留警告；超出 {@link FILE_MENTION_TOTAL_MAX_BYTES} 的条目标记为 `dropped`。
 */
export function expandFileMentions(
  input: string,
  options: ExpandFileMentionsOptions
): FileMentionExpansion {
  const rawMentions = dedupePreservingOrder(extractFileMentionTokens(input))
  if (rawMentions.length === 0) {
    return {
      prompt: input,
      results: [],
      included: [],
      warnings: [],
      paths: [],
      totalBytes: 0
    }
  }

  const singleFileMaxBytes = options.singleFileMaxBytes ?? FILE_MENTION_SINGLE_FILE_MAX_BYTES
  const totalMaxBytes = options.totalMaxBytes ?? FILE_MENTION_TOTAL_MAX_BYTES
  const allowAbsolute =
    options.allowAbsolute ?? isTrueEnv(process.env.Q_CODE_MENTION_ALLOW_ABS)
  const cwd = resolve(options.cwd)
  const results: FileMentionResult[] = []
  let totalBytes = 0

  for (const raw of rawMentions) {
    const parsed = parseFileMentionTarget(raw)
    const result = readMention(parsed, raw, {
      cwd,
      allowAbsolute,
      singleFileMaxBytes
    })

    if (result.status === 'included' && totalBytes + result.bytes > totalMaxBytes) {
      results.push({
        ...result,
        status: 'dropped',
        content: undefined,
        chars: 0,
        bytes: 0,
        reason: `@file 附件总量超过 ${formatBytes(totalMaxBytes)}，已丢弃`
      })
      continue
    }

    if (result.status === 'included') totalBytes += result.bytes
    results.push(result)
  }

  const included = results.filter((item) => item.status === 'included')
  const warnings = results
    .filter((item) => item.status !== 'included' || item.truncated)
    .map(formatMentionWarning)

  return {
    prompt: renderPromptWithMentions(input, included, warnings),
    results,
    included,
    warnings,
    paths: included.map((item) => item.absolutePath ?? item.path),
    totalBytes
  }
}

/** 构造写入 `user.mention` 审计事件的摘要 payload。 */
export function createUserMentionPayload(expansion: FileMentionExpansion): Record<string, unknown> {
  return {
    count: expansion.results.length,
    included: expansion.included.length,
    totalChars: expansion.included.reduce((sum, item) => sum + item.chars, 0),
    totalBytes: expansion.totalBytes,
    mentions: expansion.results.map((item) => ({
      path: item.path,
      ...(item.selectorLabel ? { range: item.selectorLabel } : {}),
      status: item.status,
      chars: item.chars,
      bytes: item.bytes,
      truncated: item.truncated,
      ...(item.reason ? { reason: item.reason } : {})
    }))
  }
}

/** 索引被裁剪时返回 TUI 提示文案；未裁剪时返回 `undefined`。 */
export function fileMentionIndexNotice(index: FileMentionIndex): string | undefined {
  if (index.error) return `@file 索引刷新失败，继续使用现有候选: ${compactNotice(index.error)}`
  if (index.notice) return compactNotice(index.notice)
  if (!index.truncated) return undefined
  return `@file 候选已裁剪到 ${FILE_MENTION_MAX_INDEX_FILES} 个文件，继续输入可缩小范围`
}

function readMention(
  parsed: ParsedFileMentionTarget,
  raw: string,
  options: {
    cwd: string
    allowAbsolute: boolean
    singleFileMaxBytes: number
  }
): FileMentionResult {
  const selectorLabel = parsed.selector ? formatSelector(parsed.selector) : undefined
  const baseResult = {
    raw,
    path: normalizeDisplayPath(parsed.path),
    selector: parsed.selector,
    selectorLabel,
    chars: 0,
    bytes: 0,
    truncated: false
  }

  if (!parsed.path) {
    return { ...baseResult, status: 'invalid', reason: '空文件路径' }
  }

  let absolutePath: string
  try {
    absolutePath = resolveMentionPath(options.cwd, parsed.path, options.allowAbsolute)
  } catch (error) {
    return {
      ...baseResult,
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  if (!existsSync(absolutePath)) {
    return { ...baseResult, absolutePath, status: 'missing', reason: '文件不存在' }
  }

  try {
    assertRealPathAllowed(options.cwd, absolutePath, parsed.path, options.allowAbsolute)
  } catch (error) {
    return {
      ...baseResult,
      absolutePath,
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  const stat = statSync(absolutePath)
  if (!stat.isFile()) {
    return { ...baseResult, absolutePath, status: 'invalid', reason: '路径不是文件' }
  }
  if (looksLikeBinaryFile(absolutePath, stat.size)) {
    return { ...baseResult, absolutePath, status: 'binary', reason: '文件看起来是二进制内容' }
  }

  let selection: TextSelection
  try {
    selection = readMentionTextSelection(absolutePath, parsed.selector, options.singleFileMaxBytes)
  } catch (error) {
    return {
      ...baseResult,
      absolutePath,
      status: 'invalid',
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  return {
    ...baseResult,
    absolutePath,
    status: 'included',
    content: selection.content,
    chars: selection.content.length,
    bytes: Buffer.byteLength(selection.content, 'utf-8'),
    truncated: selection.truncated
  }
}

function resolveMentionPath(cwd: string, inputPath: string, allowAbsolute: boolean): string {
  const root = resolve(cwd)
  if (isAbsolute(inputPath) && !allowAbsolute) {
    throw new Error(
      `绝对路径默认被阻止: ${inputPath}。若确实需要引用绝对路径，请设置 Q_CODE_MENTION_ALLOW_ABS=true。`
    )
  }

  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath)
  const inside = isInsideDirectory(root, absolutePath)
  if (!inside && !(allowAbsolute && isAbsolute(inputPath))) {
    throw new Error(`路径越界: ${inputPath} 不在当前工作目录内`)
  }

  return absolutePath
}

function assertRealPathAllowed(
  cwd: string,
  absolutePath: string,
  inputPath: string,
  allowAbsolute: boolean
): void {
  const realRoot = realpathSync.native(resolve(cwd))
  const realTarget = realpathSync.native(absolutePath)
  const inside = isInsideDirectory(realRoot, realTarget)
  if (!inside && !(allowAbsolute && isAbsolute(inputPath))) {
    throw new Error(`路径越界: ${inputPath} 指向当前工作目录外的真实路径`)
  }
}

interface TextSelection {
  content: string
  truncated: boolean
}

function readMentionTextSelection(
  filePath: string,
  selector: FileMentionSelector | undefined,
  maxBytes: number
): TextSelection {
  if (!selector) return readTextPrefix(filePath, maxBytes)
  if (selector.type === 'line') {
    if (selector.line < 1) throw new Error('行号必须大于 0')
    return readSelectedLines(filePath, selector.line, selector.line, maxBytes)
  }
  if (selector.type === 'range') {
    if (selector.startLine < 1 || selector.endLine < 1) throw new Error('行号范围必须大于 0')
    if (selector.endLine < selector.startLine) {
      throw new Error(`行号范围无效: ${selector.startLine}-${selector.endLine}`)
    }
    return readSelectedLines(filePath, selector.startLine, selector.endLine, maxBytes)
  }
  return readRegexLine(filePath, selector.pattern, maxBytes)
}

function renderPromptWithMentions(
  input: string,
  included: FileMentionResult[],
  warnings: string[]
): string {
  if (included.length === 0 && warnings.length === 0) return input

  const blocks = included.map((item) =>
    [
      `<file path="${escapeXmlAttr(item.path)}"${item.selectorLabel ? ` range="${escapeXmlAttr(item.selectorLabel)}"` : ''} chars="${item.chars}" bytes="${item.bytes}" truncated="${item.truncated ? 'true' : 'false'}">`,
      '<![CDATA[',
      escapeCdata(item.content ?? ''),
      ']]>',
      '</file>'
    ].join('\n')
  )
  const warningBlocks = warnings.map((warning) => `<warning>${escapeXmlText(warning)}</warning>`)

  return [
    input,
    '',
    '<q-code-file-mentions>',
    '以下内容来自用户输入中的 @file 引用，请作为本轮上下文使用。',
    ...blocks,
    ...warningBlocks,
    '</q-code-file-mentions>'
  ].join('\n')
}

function formatMentionWarning(item: FileMentionResult): string {
  if (item.status === 'included' && item.truncated) {
    return `${item.path}${item.selectorLabel ? `:${item.selectorLabel}` : ''} 超过单文件 ${formatBytes(FILE_MENTION_SINGLE_FILE_MAX_BYTES)}，已截断`
  }
  return `${item.path}${item.selectorLabel ? `:${item.selectorLabel}` : ''} ${item.reason ?? item.status}`
}

function readGitFileIndex(cwd: string, maxFiles: number): Promise<FileMentionIndex | null> {
  return new Promise((resolveIndex) => {
    const child = spawn('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd,
      env: createGitFileIndexEnv(),
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const files: string[] = []
    let buffered = Buffer.alloc(0)
    let totalFiles = 0
    let truncated = false
    let settled = false

    const settle = (index: FileMentionIndex | null) => {
      if (settled) return
      settled = true
      resolveIndex(index)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      let nullIndex = buffered.indexOf(0)
      while (nullIndex >= 0) {
        const file = normalizeDisplayPath(buffered.subarray(0, nullIndex).toString('utf-8'))
        buffered = buffered.subarray(nullIndex + 1)
        if (file && !shouldSkipInternalIndexPath(file)) {
          totalFiles++
          if (files.length < maxFiles) files.push(file)
          if (totalFiles > maxFiles) {
            truncated = true
            child.kill()
            break
          }
        }
        nullIndex = buffered.indexOf(0)
      }
    })

    child.once('error', () => settle(null))
    child.once('close', (code) => {
      if (code !== 0 && files.length === 0) {
        settle(null)
        return
      }
      const sorted = [...new Set(files)].sort((a, b) => a.localeCompare(b))
      settle({
        cwd,
        files: sorted,
        totalFiles,
        truncated,
        source: 'git'
      })
    })
  })
}

function createGitFileIndexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of GIT_LOCAL_ENV_KEYS) delete env[key]
  return env
}

function walkFileIndex(
  cwd: string,
  maxFiles: number,
  extraIgnoreDirs: Iterable<string> = []
): FileMentionIndex {
  const files: string[] = []
  const stack = [cwd]
  let seen = 0
  const skipDirs = new Set([...FALLBACK_SKIP_DIRS, ...extraIgnoreDirs].filter(Boolean))

  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) continue

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }

    for (const entry of entries.sort((a, b) => b.localeCompare(a))) {
      const absolutePath = resolve(dir, entry)
      let stat
      try {
        stat = lstatSync(absolutePath)
      } catch {
        continue
      }

      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (!skipDirs.has(entry)) stack.push(absolutePath)
        continue
      }
      if (!stat.isFile()) continue

      seen++
      if (files.length < maxFiles) {
        files.push(normalizeDisplayPath(relative(cwd, absolutePath)))
      }
      if (seen > maxFiles) {
        return {
          cwd,
          files: files.sort((a, b) => a.localeCompare(b)),
          totalFiles: seen,
          truncated: true,
          source: 'walk'
        }
      }
    }
  }

  return {
    cwd,
    files: files.sort((a, b) => a.localeCompare(b)),
    totalFiles: seen,
    truncated: false,
    source: 'walk'
  }
}

function stripSelectorFromQuery(query: string): string {
  return parseFileMentionTarget(query).path
}

/** 将路径格式化为可插入输入框的 `@file` token（含空格时加引号）。 */
export function formatFileMentionTarget(path: string): string {
  return /\s/.test(path) ? `@"${path.replace(/"/g, '\\"')}"` : `@${path}`
}

function trimMentionToken(value: string): string {
  return value.replace(/[),.;!?，。；！？）]+$/u, '')
}

function normalizeQuery(value: string): string {
  return stripSelectorFromQuery(value).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

function normalizeDisplayPath(value: string): string {
  return value.replaceAll(sep, '/').replace(/\\/g, '/').replace(/^\.\//, '')
}

function shouldSkipInternalIndexPath(path: string): boolean {
  const firstSegment = path.split('/')[0]
  return firstSegment ? INTERNAL_INDEX_SKIP_DIRS.has(firstSegment) : false
}

function compactNotice(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  return singleLine.length > 80 ? `${singleLine.slice(0, 79)}…` : singleLine
}

function isPathBoundary(char: string | undefined): boolean {
  return char === '/' || char === '-' || char === '_' || char === '.'
}

function isTokenBoundary(char: string): boolean {
  return /\s/.test(char)
}

function formatSelector(selector: FileMentionSelector): string {
  if (selector.type === 'line') return String(selector.line)
  if (selector.type === 'range') return `${selector.startLine}-${selector.endLine}`
  return `#${selector.pattern}`
}

function readTextPrefix(filePath: string, maxBytes: number): TextSelection {
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes + 4)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    const decoder = new StringDecoder('utf8')
    const decoded = decoder.write(buffer.subarray(0, bytesRead))
    const content = truncateUtf8(decoded, maxBytes)
    return {
      content,
      truncated: bytesRead > maxBytes || Buffer.byteLength(decoded, 'utf-8') > maxBytes
    }
  } finally {
    closeSync(fd)
  }
}

function readSelectedLines(
  filePath: string,
  startLine: number,
  endLine: number,
  maxBytes: number
): TextSelection {
  let output = ''
  let truncated = false
  const scan = forEachTextLine(filePath, (line, lineNo) => {
    if (lineNo < startLine) return true
    if (lineNo > endLine) {
      return false
    }

    const rendered = output ? `\n${line}` : line
    const next = appendWithinByteLimit(output, rendered, maxBytes)
    output = next.content
    if (next.truncated) {
      truncated = true
      return false
    }
    return true
  })
  return { content: output, truncated: truncated || scan.hitScanLimit }
}

function readRegexLine(filePath: string, pattern: string, maxBytes: number): TextSelection {
  if (pattern.length > MAX_REGEX_PATTERN_CHARS) {
    throw new Error(`正则过长: 最大 ${MAX_REGEX_PATTERN_CHARS} 字符`)
  }
  if (isPotentiallyUnsafeRegex(pattern)) {
    throw new Error('正则包含高风险回溯结构，已拒绝执行')
  }

  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (error) {
    throw new Error(`正则无效: ${error instanceof Error ? error.message : String(error)}`)
  }

  let matched: string | undefined
  const scan = forEachTextLine(
    filePath,
    (line) => {
      const candidate = line.slice(0, MAX_REGEX_LINE_CHARS)
      if (regex.test(candidate)) {
        matched = candidate
        return false
      }
      return true
    },
    MAX_SELECTOR_SCAN_BYTES
  )

  if (matched === undefined) {
    throw new Error(
      scan.hitScanLimit
        ? `未在前 ${formatBytes(MAX_SELECTOR_SCAN_BYTES)} 内找到匹配正则: ${pattern}`
        : `未找到匹配正则: ${pattern}`
    )
  }
  return {
    content: truncateUtf8(matched, maxBytes),
    truncated: Buffer.byteLength(matched, 'utf-8') > maxBytes
  }
}

interface LineScanResult {
  hitScanLimit: boolean
}

function forEachTextLine(
  filePath: string,
  onLine: (line: string, lineNo: number) => boolean,
  maxScanBytes = MAX_SELECTOR_SCAN_BYTES
): LineScanResult {
  const fd = openSync(filePath, 'r')
  const decoder = new StringDecoder('utf8')
  const buffer = Buffer.alloc(READ_CHUNK_BYTES)
  let pending = ''
  let lineNo = 0
  let scannedBytes = 0
  let stopped = false
  let reachedEof = false

  try {
    while (scannedBytes < maxScanBytes) {
      const bytesToRead = Math.min(buffer.length, maxScanBytes - scannedBytes)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, null)
      if (bytesRead === 0) {
        reachedEof = true
        break
      }
      scannedBytes += bytesRead
      pending += decoder.write(buffer.subarray(0, bytesRead))

      let nextBreak = findLineBreak(pending)
      while (nextBreak) {
        const line = pending.slice(0, nextBreak.index)
        pending = pending.slice(nextBreak.nextIndex)
        lineNo++
        if (!onLine(line, lineNo)) {
          stopped = true
          return { hitScanLimit: false }
        }
        nextBreak = findLineBreak(pending)
      }
    }

    pending += decoder.end()
    if (pending) {
      lineNo++
      if (!onLine(pending, lineNo)) stopped = true
    }
    return { hitScanLimit: !reachedEof && !stopped && scannedBytes >= maxScanBytes }
  } finally {
    closeSync(fd)
  }
}

function findLineBreak(value: string): { index: number; nextIndex: number } | null {
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '\n') return { index, nextIndex: index + 1 }
    if (char === '\r') {
      return { index, nextIndex: value[index + 1] === '\n' ? index + 2 : index + 1 }
    }
  }
  return null
}

function appendWithinByteLimit(current: string, addition: string, maxBytes: number): TextSelection {
  const next = current + addition
  if (Buffer.byteLength(next, 'utf-8') <= maxBytes) return { content: next, truncated: false }
  return { content: truncateUtf8(next, maxBytes), truncated: true }
}

function isPotentiallyUnsafeRegex(pattern: string): boolean {
  return (
    /\([^)]*[*+][^)]*\)\s*[*+{]/.test(pattern) ||
    /\([^)]*\{[^)]*\}[^)]*\)\s*[*+{]/.test(pattern) ||
    /\([^)]*\|[^)]*\)\s*[*+{]/.test(pattern) ||
    /\\[1-9]/.test(pattern) ||
    /(\.\*){2,}/.test(pattern) ||
    /(\.\+){2,}/.test(pattern)
  )
}

function splitTextUnits(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const Segmenter = Intl.Segmenter
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(value), (segment) => segment.segment)
  }
  return Array.from(value)
}

function findClosingQuote(chars: string[], start: number, quote: string): number {
  for (let index = start; index < chars.length; index++) {
    if (chars[index] === quote && chars[index - 1] !== '\\') return index
  }
  return -1
}

function unescapeQuotedPath(value: string): string {
  return value.replace(/\\(["'\\])/g, '$1')
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value

  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, mid), 'utf-8') <= maxBytes) low = mid
    else high = mid - 1
  }
  return value.slice(0, low)
}

function looksLikeBinaryFile(filePath: string, fileSize: number): boolean {
  if (fileSize === 0) return false

  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(8192, fileSize))
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    closeSync(fd)
  }
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeCdata(value: string): string {
  return value.replace(/\]\]>/g, ']]]]><![CDATA[>')
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}
