/**
 * 通用工具：fetch_url、glob、grep、本地预览服务器等。
 */
import { createReadStream, readFileSync, statSync, existsSync } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { createInterface } from 'node:readline'
import fg from 'fast-glob'
import type { ToolDefinition, ToolExecutionContext } from './registry'
import { resolveToolPath, isInsideDirectory } from './path-policy'
import { safeFetchUrl } from './safe-fetch'

export const SEARCH_IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.sessions',
  '.q-code',
  '.playground',
  '.playwright-mcp',
  '.next',
  '.cache',
  '.pnpm-store',
  'AppData',
  'Library',
  'target',
  'vendor'
] as const

/** 与 {@link SEARCH_IGNORE_DIRS} 对应的 fast-glob 忽略模式。 */
export const SEARCH_IGNORE_GLOBS = SEARCH_IGNORE_DIRS.map((dir) => `${dir}/**`)

const GREP_DEFAULT_TIMEOUT_MS = 8000
const GREP_MAX_MATCHES = 50
const GREP_MAX_FILES_SCANNED = 5000
const GREP_MAX_DIRS_SCANNED = 1000
const GREP_MAX_BYTES_SCANNED = 30 * 1024 * 1024
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024
const GREP_MAX_LINE_CHARS = 20000

const GREP_BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.bin',
  '.bmp',
  '.class',
  '.dll',
  '.doc',
  '.docx',
  '.exe',
  '.gif',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lock',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.rar',
  '.sqlite',
  '.webp',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.zip'
])

/** 安全抓取单个 URL 的原始内容。 */
export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description: '抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头' }
    },
    required: ['url'],
    additionalProperties: false
  },
  isConcurrencySafe: true, // 只读、可并发——抓多个 URL 时直接并行
  isReadOnly: true,
  contextCost: 'high',
  resultShape: 'web',
  jitHint: '先搜索/确认 URL，再抓正文',
  maxResultChars: 1500, // 网页通常很长，截断兜底
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await safeFetchUrl(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 SuperAgent' },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) return `请求失败：HTTP ${res.status}`
      const html = await res.text()
      return (
        html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() || '页面无文本内容'
      )
    } catch (err: any) {
      return `抓取失败：${err.message}`
    }
  }
}

/** 按 glob 模式查找文件路径。 */
export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  contextCost: 'low',
  resultShape: 'paths',
  jitHint: '先用它缩小候选文件集',
  execute: async (
    { pattern, path = '.' }: { pattern: string; path?: string },
    context: ToolExecutionContext
  ) => {
    let cwd: string
    try {
      cwd = resolveToolPath(context.cwd, path)
    } catch (err) {
      return `路径错误: ${err instanceof Error ? err.message : err}`
    }
    const results = await fg(pattern, {
      cwd,
      ignore: SEARCH_IGNORE_GLOBS,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false
    })
    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`
    return results.sort().join('\n')
  }
}

/** 在仓库内按正则搜索文件内容。 */
export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  contextCost: 'medium',
  resultShape: 'lines',
  jitHint: '用匹配行定位后再读文件',
  maxResultChars: 3000,
  execute: async (
    { pattern, path = '.' }: { pattern: string; path?: string },
    context: ToolExecutionContext
  ) => {
    let basePath: string
    try {
      basePath = resolveToolPath(context.cwd, path)
    } catch (err) {
      return `路径错误: ${err instanceof Error ? err.message : err}`
    }

    return grepPath(pattern, basePath, context)
  }
}

interface GrepStats {
  dirsScanned: number
  filesScanned: number
  bytesScanned: number
  skippedLargeFiles: number
  skippedBinaryFiles: number
  skippedSymlinks: number
  skippedUnreadable: number
}

interface GrepBudget {
  startedAt: number
  timeoutMs: number
  aborted: boolean
  stoppedReason?: string
}

async function grepPath(
  pattern: string,
  basePath: string,
  context: ToolExecutionContext
): Promise<string> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'i')
  } catch (err) {
    return `正则表达式错误: ${err instanceof Error ? err.message : err}`
  }

  const matches: string[] = []
  const stats: GrepStats = {
    dirsScanned: 0,
    filesScanned: 0,
    bytesScanned: 0,
    skippedLargeFiles: 0,
    skippedBinaryFiles: 0,
    skippedSymlinks: 0,
    skippedUnreadable: 0
  }
  const budget: GrepBudget = {
    startedAt: Date.now(),
    timeoutMs: GREP_DEFAULT_TIMEOUT_MS,
    aborted: false
  }

  async function shouldStop(): Promise<boolean> {
    if (matches.length >= GREP_MAX_MATCHES) {
      budget.stoppedReason = `结果已截断，共 ${GREP_MAX_MATCHES}+ 条匹配`
      return true
    }
    if (context.abortSignal?.aborted) {
      budget.aborted = true
      budget.stoppedReason = '调用已取消'
      return true
    }
    if (Date.now() - budget.startedAt >= budget.timeoutMs) {
      budget.stoppedReason = `搜索超过 ${budget.timeoutMs}ms，已提前停止`
      return true
    }
    if (stats.filesScanned >= GREP_MAX_FILES_SCANNED) {
      budget.stoppedReason = `扫描文件数达到上限 ${GREP_MAX_FILES_SCANNED}，已提前停止`
      return true
    }
    if (stats.dirsScanned >= GREP_MAX_DIRS_SCANNED) {
      budget.stoppedReason = `扫描目录数达到上限 ${GREP_MAX_DIRS_SCANNED}，已提前停止`
      return true
    }
    if (stats.bytesScanned >= GREP_MAX_BYTES_SCANNED) {
      budget.stoppedReason = `扫描内容达到上限 ${formatBytes(GREP_MAX_BYTES_SCANNED)}，已提前停止`
      return true
    }
    return false
  }

  async function searchFile(filePath: string): Promise<void> {
    if (await shouldStop()) return
    if (shouldSkipFileByExtension(filePath)) {
      stats.skippedBinaryFiles++
      return
    }

    let stat
    try {
      stat = await lstat(filePath)
    } catch {
      stats.skippedUnreadable++
      return
    }
    if (stat.isSymbolicLink()) {
      stats.skippedSymlinks++
      return
    }
    if (!stat.isFile()) return
    if (stat.size > GREP_MAX_FILE_BYTES) {
      stats.skippedLargeFiles++
      return
    }
    if (await looksLikeBinaryFileAsync(filePath, stat.size)) {
      stats.skippedBinaryFiles++
      return
    }

    stats.filesScanned++
    stats.bytesScanned += stat.size

    const rel = relative(basePath, filePath) || filePath
    const stream = createReadStream(filePath, { encoding: 'utf-8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    let lineNo = 0

    try {
      for await (const rawLine of rl) {
        lineNo++
        if (lineNo % 100 === 0 && (await shouldStop())) break
        const line = rawLine.length > GREP_MAX_LINE_CHARS
          ? rawLine.slice(0, GREP_MAX_LINE_CHARS)
          : rawLine
        if (regex.test(line)) {
          matches.push(`${rel}:${lineNo}: ${line.trimEnd()}`)
          if (await shouldStop()) break
        }
      }
    } catch {
      stats.skippedUnreadable++
    } finally {
      rl.close()
      stream.destroy()
    }
  }

  async function walk(dir: string): Promise<void> {
    if (await shouldStop()) return

    stats.dirsScanned++
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      stats.skippedUnreadable++
      return
    }

    for (const entry of entries) {
      if (await shouldStop()) return
      if (SEARCH_IGNORE_DIRS.includes(entry.name as (typeof SEARCH_IGNORE_DIRS)[number])) continue

      const full = join(dir, entry.name)
      try {
        if (entry.isSymbolicLink()) {
          stats.skippedSymlinks++
          continue
        }
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          await searchFile(full)
        }
      } catch {
        stats.skippedUnreadable++
      }
    }
  }

  try {
    const stat = await lstat(basePath)
    if (stat.isSymbolicLink()) {
      stats.skippedSymlinks++
    } else if (stat.isFile()) {
      await searchFile(basePath)
    } else if (stat.isDirectory()) {
      await walk(basePath)
    } else {
      return `路径不是可搜索的文件或目录: ${basePath}`
    }
  } catch (err) {
    return `搜索失败: ${err instanceof Error ? err.message : err}`
  }

  return formatGrepResult(pattern, matches, stats, budget)
}

function formatGrepResult(
  pattern: string,
  matches: string[],
  stats: GrepStats,
  budget: GrepBudget
): string {
  const notices: string[] = []
  if (budget.stoppedReason) notices.push(budget.stoppedReason)
  if (stats.skippedLargeFiles > 0) notices.push(`跳过 ${stats.skippedLargeFiles} 个超大文件`)
  if (stats.skippedBinaryFiles > 0) notices.push(`跳过 ${stats.skippedBinaryFiles} 个二进制/锁文件`)
  if (stats.skippedSymlinks > 0) notices.push(`跳过 ${stats.skippedSymlinks} 个符号链接`)
  if (stats.skippedUnreadable > 0) notices.push(`跳过 ${stats.skippedUnreadable} 个不可读路径`)

  const summary = [
    `扫描: ${stats.dirsScanned} 个目录，${stats.filesScanned} 个文件，${formatBytes(stats.bytesScanned)}`,
    notices.length ? `提示: ${notices.join('；')}` : null
  ].filter((line): line is string => line !== null)

  if (matches.length === 0) {
    return [`没有找到匹配 "${pattern}" 的内容`, ...summary].join('\n')
  }

  return [...matches, ...summary.map((line) => `... (${line})`)].join('\n')
}

function shouldSkipFileByExtension(filePath: string): boolean {
  return GREP_BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

async function looksLikeBinaryFileAsync(filePath: string, fileSize: number): Promise<boolean> {
  if (fileSize === 0) return false

  let handle
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(Math.min(8192, fileSize))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } catch {
    return true
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

let previewServer: Server | null = null

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8', // 让浏览器把 .tsx 当 JS 加载
  '.ts': 'application/javascript; charset=utf-8'
  // ...
}

/** 启动本地 HTTP 预览静态文件。 */
export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description: '启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具',
  parameters: {
    type: 'object',
    properties: { port: { type: 'number' } },
    required: [],
    additionalProperties: false
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  contextCost: 'medium',
  resultShape: 'state',
  jitHint: '只在生成应用文件后启动预览',
  execute: async (
    { port = 8080 }: { port?: number } = {},
    context: ToolExecutionContext
  ) => {
    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`
    const root = resolve(context.cwd, 'app')
    if (!existsSync(root)) return '错误：app/ 目录不存在'

    previewServer = createServer((req, res) => {
      try {
        const filePath = resolvePreviewFilePath(root, req.url)
        if (!filePath) {
          res.writeHead(403)
          res.end()
          return
        }
        const stat = statSync(filePath)
        if (!stat.isFile()) {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        })
        res.end(readFileSync(filePath))
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })

    return new Promise<string>((resolve) => {
      previewServer!.listen(port, () => {
        resolve(`✓ 预览服务器已启动 → http://localhost:${port}`)
      })
    })
  }
}

/** 将预览 URL 解析为 root 下的绝对文件路径。 */
export function resolvePreviewFilePath(root: string, rawUrl: string | undefined): string | null {
  const rawPath = rawUrl?.split('?')[0] || '/'
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    return null
  }

  const normalizedPath = decodedPath.replace(/\/$/, '/index.html')
  const relativePath = normalizedPath === '/' ? 'index.html' : `.${normalizedPath}`
  const filePath = resolve(root, relativePath)
  return isInsideDirectory(root, filePath) ? filePath : null
}
