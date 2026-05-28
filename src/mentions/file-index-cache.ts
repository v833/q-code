/**
 * `@file` 候选索引缓存与后台刷新：启动先用项目缓存，再异步重建并监听文件变化。
 */
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { writeJsonAtomic } from '../utils/atomic-write'
import { createEmptyFileMentionIndex, createFileMentionIndex, FILE_MENTION_MAX_INDEX_FILES, type FileMentionIndex } from './file-mentions'

const CACHE_VERSION = 1
const MAX_CACHE_BYTES = 25 * 1024 * 1024
const DEFAULT_REFRESH_DEBOUNCE_MS = 1_000
const DEFAULT_WATCH_FALLBACK_POLL_MS = 10_000
const DEFAULT_FILE_INDEX_IGNORE = ['.q-code', '.sessions', '.playground', '.playwright-mcp']
const INTERNAL_CACHE_SKIP_PREFIXES = ['.q-code/', '.sessions/', '.playground/', '.playwright-mcp/']

type FileMentionIndexWatchFactory = (
  cwd: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | Buffer | null) => void
) => FileMentionIndexWatchHandle

interface FileMentionIndexWatchHandle {
  close(): void
  on(event: 'error', listener: (error: Error) => void): FileMentionIndexWatchHandle
}

/** 可订阅的 `@file` 索引 store。 */
export interface FileMentionIndexStore {
  getSnapshot(): FileMentionIndex
  subscribe(listener: (index: FileMentionIndex) => void): () => void
  refresh(): Promise<FileMentionIndex>
  close(): void
}

/** 创建 `@file` 索引 store 的选项。 */
export interface CreateFileMentionIndexStoreOptions {
  maxFiles?: number
  autoRefresh?: boolean
  watchFiles?: boolean
  refreshDebounceMs?: number
  watchFallbackPollMs?: number
  cachePath?: string
  ignoreDirs?: string[]
  env?: NodeJS.ProcessEnv
  watchFactory?: FileMentionIndexWatchFactory
  buildIndex?: (cwd: string, maxFiles: number, ignoreDirs: string[]) => Promise<FileMentionIndex>
}

interface FileMentionIndexCacheFile {
  version: typeof CACHE_VERSION
  cwd: string
  maxFiles: number
  savedAt: string
  index: {
    source: 'git' | 'walk'
    files: string[]
    totalFiles: number
    truncated: boolean
  }
}

/** 创建会读取缓存、后台刷新并监听文件变化的 `@file` 索引 store。 */
export function createFileMentionIndexStore(
  cwd: string,
  options: CreateFileMentionIndexStoreOptions = {}
): FileMentionIndexStore {
  return new DefaultFileMentionIndexStore(cwd, options)
}

/** 项目级 `@file` 索引缓存路径。 */
export function getFileMentionIndexCachePath(cwd: string): string {
  return join(resolve(cwd), '.q-code', 'file-mention-index.json')
}

class DefaultFileMentionIndexStore implements FileMentionIndexStore {
  private readonly cwd: string
  private readonly maxFiles: number
  private readonly cachePath: string
  private readonly ignoreDirs: string[]
  private readonly refreshDebounceMs: number
  private readonly watchFallbackPollMs: number
  private readonly buildIndex: (cwd: string, maxFiles: number, ignoreDirs: string[]) => Promise<FileMentionIndex>
  private readonly watchFactory: FileMentionIndexWatchFactory
  private readonly listeners = new Set<(index: FileMentionIndex) => void>()
  private watcher?: FileMentionIndexWatchHandle
  private refreshTimer?: ReturnType<typeof setTimeout>
  private fallbackPollTimer?: ReturnType<typeof setInterval>
  private refreshInFlight?: Promise<FileMentionIndex>
  private refreshAgain = false
  private closed = false
  private watchNotice?: string
  private snapshot: FileMentionIndex

  constructor(cwd: string, options: CreateFileMentionIndexStoreOptions) {
    this.cwd = resolve(cwd)
    this.maxFiles = options.maxFiles ?? FILE_MENTION_MAX_INDEX_FILES
    this.cachePath = options.cachePath ?? getFileMentionIndexCachePath(this.cwd)
    this.ignoreDirs = resolveIgnoreDirs(options)
    this.refreshDebounceMs = options.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS
    this.watchFallbackPollMs = options.watchFallbackPollMs ?? DEFAULT_WATCH_FALLBACK_POLL_MS
    this.buildIndex =
      options.buildIndex ??
      ((root, maxFiles, ignoreDirs) => createFileMentionIndex(root, maxFiles, { ignoreDirs }))
    this.watchFactory = options.watchFactory ?? defaultWatchFactory
    this.snapshot =
      readCachedFileMentionIndex(this.cachePath, this.cwd, this.maxFiles) ??
      createEmptyFileMentionIndex(this.cwd)

    if (options.watchFiles !== false) this.startWatcher()
    if (options.autoRefresh !== false) {
      this.refresh().catch(() => undefined)
    }
  }

  getSnapshot(): FileMentionIndex {
    return this.snapshot
  }

  subscribe(listener: (index: FileMentionIndex) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async refresh(): Promise<FileMentionIndex> {
    if (this.closed) return this.snapshot
    if (this.refreshInFlight) {
      this.refreshAgain = true
      return this.refreshInFlight
    }

    this.refreshInFlight = this.runRefresh()
    try {
      return await this.refreshInFlight
    } finally {
      this.refreshInFlight = undefined
      if (this.refreshAgain && !this.closed) {
        this.refreshAgain = false
        this.scheduleRefresh()
      }
    }
  }

  close(): void {
    this.closed = true
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    if (this.fallbackPollTimer) clearInterval(this.fallbackPollTimer)
    this.fallbackPollTimer = undefined
    this.watcher?.close()
    this.watcher = undefined
    this.listeners.clear()
  }

  private async runRefresh(): Promise<FileMentionIndex> {
    try {
      const index = {
        ...(await this.buildIndex(this.cwd, this.maxFiles, this.ignoreDirs)),
        updatedAt: new Date().toISOString(),
        error: undefined,
        notice: this.watchNotice
      }
      this.setSnapshot(index)
      await writeCachedFileMentionIndex(this.cachePath, this.cwd, this.maxFiles, index)
      return index
    } catch (error) {
      const failed = {
        ...this.snapshot,
        error: formatIndexRefreshError(error)
      }
      this.setSnapshot(failed)
      return failed
    }
  }

  private startWatcher(): void {
    const onChange = (_event: string, filename: string | Buffer | null) => {
      if (this.closed || shouldIgnoreWatchEvent(filename)) return
      this.scheduleRefresh()
    }

    try {
      this.watcher = this.watchFactory(this.cwd, { recursive: true }, onChange)
      this.watcher.on('error', (error) => {
        this.handleWatcherFailure(error)
      })
      return
    } catch {
      // 部分平台不支持 recursive watch；退化为根目录监听，至少覆盖根层文件变更。
    }

    try {
      this.watcher = this.watchFactory(this.cwd, { recursive: false }, onChange)
      this.startFallbackPolling()
      this.watcher.on('error', (error) => {
        this.handleWatcherFailure(error)
      })
    } catch {
      this.handleWatcherFailure(new Error('file watcher unavailable'))
    }
  }

  private scheduleRefresh(): void {
    if (this.closed) return
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      this.refresh().catch(() => undefined)
    }, this.refreshDebounceMs)
  }

  private setSnapshot(index: FileMentionIndex): void {
    this.snapshot = index
    for (const listener of this.listeners) listener(index)
  }

  private handleWatcherFailure(error: unknown): void {
    if (this.closed) return
    this.watcher?.close()
    this.watcher = undefined
    this.startFallbackPolling()
    this.watchNotice = `@file 文件监听不可用，已改为定时刷新: ${formatIndexRefreshError(error)}`
    this.setSnapshot({ ...this.snapshot, notice: this.watchNotice })
  }

  private startFallbackPolling(): void {
    if (this.closed || this.fallbackPollTimer) return
    this.fallbackPollTimer = setInterval(() => {
      this.refresh().catch(() => undefined)
    }, this.watchFallbackPollMs)
  }
}

function readCachedFileMentionIndex(
  cachePath: string,
  cwd: string,
  maxFiles: number
): FileMentionIndex | undefined {
  try {
    if (!existsSync(cachePath)) return undefined
    if (statSync(cachePath).size > MAX_CACHE_BYTES) return undefined
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as unknown
    const cache = validateCacheFile(parsed, cwd, maxFiles)
    if (!cache) return undefined
    const files = cache.index.files.filter((file) => !shouldSkipCachedIndexPath(file))
    const removed = cache.index.files.length - files.length
    return {
      cwd,
      files,
      totalFiles: Math.max(files.length, cache.index.totalFiles - removed),
      truncated: cache.index.truncated,
      source: 'cache',
      cachedSource: cache.index.source,
      updatedAt: cache.savedAt
    }
  } catch {
    return undefined
  }
}

async function writeCachedFileMentionIndex(
  cachePath: string,
  cwd: string,
  maxFiles: number,
  index: FileMentionIndex
): Promise<void> {
  if (index.source === 'empty' || index.source === 'cache') return
  const cache: FileMentionIndexCacheFile = {
    version: CACHE_VERSION,
    cwd,
    maxFiles,
    savedAt: index.updatedAt ?? new Date().toISOString(),
    index: {
      source: index.source,
      files: index.files,
      totalFiles: index.totalFiles,
      truncated: index.truncated
    }
  }
  await mkdirForFile(cachePath)
  await writeJsonAtomic(cachePath, cache)
}

function validateCacheFile(
  value: unknown,
  cwd: string,
  maxFiles: number
): FileMentionIndexCacheFile | undefined {
  const record = asRecord(value)
  const index = asRecord(record?.index)
  if (!record || !index) return undefined
  if (record.version !== CACHE_VERSION || record.cwd !== cwd || record.maxFiles !== maxFiles) return undefined
  if (index.source !== 'git' && index.source !== 'walk') return undefined
  if (!Array.isArray(index.files) || index.files.some((item) => typeof item !== 'string')) return undefined
  if (typeof index.totalFiles !== 'number' || typeof index.truncated !== 'boolean') return undefined
  if (index.files.length > maxFiles) return undefined
  return {
    version: CACHE_VERSION,
    cwd,
    maxFiles,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date(0).toISOString(),
    index: {
      source: index.source,
      files: index.files,
      totalFiles: index.totalFiles,
      truncated: index.truncated
    }
  }
}

function resolveIgnoreDirs(options: CreateFileMentionIndexStoreOptions): string[] {
  const envIgnore = (options.env ?? process.env).Q_CODE_FILE_INDEX_IGNORE
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? []
  return [...new Set([...DEFAULT_FILE_INDEX_IGNORE, ...envIgnore, ...(options.ignoreDirs ?? [])])]
}

function defaultWatchFactory(
  cwd: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | Buffer | null) => void
): FSWatcher {
  return options.recursive
    ? watch(cwd, { recursive: true }, listener)
    : watch(cwd, listener)
}

async function mkdirForFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

function shouldIgnoreWatchEvent(filename: string | Buffer | null): boolean {
  if (!filename) return false
  const normalized = String(filename).replace(/\\/g, '/')
  return normalized.startsWith('.q-code/') || normalized === '.q-code' || normalized.startsWith('.git/')
}

function shouldSkipCachedIndexPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return INTERNAL_CACHE_SKIP_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function formatIndexRefreshError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const compact = message.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact || 'unknown error'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
