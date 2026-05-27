/**
 * TUI 输入历史持久化：按项目/全局 JSONL 保存 prompt，提供过滤、合并、轮转与本会话开关。
 */
import { createHash } from 'node:crypto'
import { constants, existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { writeTextAtomic } from '../utils/atomic-write'
import { isTrueEnv } from '../utils/env'

/** 输入历史持久化作用域。 */
export type HistoryScope = 'global' | 'project' | 'both'

/** Ctrl+R 历史搜索模式。 */
export type HistorySearchMode = 'substring' | 'fuzzy'

/** 历史文件中的一条 JSONL 记录。 */
export interface HistoryEntry {
  ts: string
  sessionId: string
  cwd: string
  value: string
  chars: number
  truncated?: boolean
  redacted?: boolean
  sha256?: string
  scope?: Exclude<HistoryScope, 'both'>
}

/** 历史存储当前配置。 */
export interface HistoryStoreConfig {
  disabled: boolean
  scope: HistoryScope
  redact: boolean
  maxLines: number
  maxBytes: number
  runtimeLimit: number
  maxLineBytes: number
  searchMode: HistorySearchMode
  excludePatterns: RegExp[]
  cwd: string
  qCodeHome: string
  globalPath: string
  projectPath: string
}

/** append 后的结果，用于测试与诊断。 */
export interface HistoryAppendResult {
  persisted: boolean
  skippedReason?: string
  paths: string[]
}

/** 输入历史存储接口。 */
export interface HistoryStore {
  load(): Promise<string[]>
  loadEntries(limit?: number): Promise<HistoryEntry[]>
  search(query: string, limit?: number): Promise<HistoryEntry[]>
  append(input: string): Promise<HistoryAppendResult>
  clear(scope?: HistoryScope): Promise<void>
  shouldRecord(input: string): boolean
  setSessionEnabled(enabled: boolean): void
  isSessionEnabled(): boolean
  isDisabled(): boolean
  getSearchMode(): HistorySearchMode
  getRuntimeLimit(): number
  getConfig(): HistoryStoreConfig
  setContext(context: HistoryStoreContext): void
  subscribe(listener: () => void): () => void
}

/** 创建历史存储所需上下文。 */
export interface HistoryStoreContext {
  cwd: string
  sessionId: string
}

/** 创建历史存储的可覆盖选项，主要供测试注入。 */
export interface CreateHistoryStoreOptions extends HistoryStoreContext {
  env?: NodeJS.ProcessEnv
  qCodeHome?: string
  now?: () => Date
  settings?: HistorySettings
}

/** settings.json 中支持的 history 配置。 */
export interface HistorySettings {
  excludePatterns?: string[]
  excludeDefaults?: boolean
  search?: HistorySearchMode
}

const DEFAULT_MAX_LINES = 20_000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_RUNTIME_LIMIT = 2_000
const DEFAULT_MAX_LINE_BYTES = 32 * 1024
const HISTORY_MAX_BYTES_LIMIT = 100 * 1024 * 1024
const HISTORY_MAX_LINE_BYTES_LIMIT = 1024 * 1024
const HISTORY_RUNTIME_LIMIT_LIMIT = 100_000
const HISTORY_MAX_LINES_LIMIT = 1_000_000
const LOCK_STALE_MS = 60_000
const LOCK_RETRY_DELAY_MS = 20
const LOCK_ATTEMPTS = 200
const DEFAULT_EXCLUDE_PATTERNS = [/password\s*=/i, /api[_-]?key\s*=/i, /token\s*=/i]
const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

/** 创建一个面向当前 cwd/session 的输入历史存储。 */
export function createHistoryStore(options: CreateHistoryStoreOptions): HistoryStore {
  return new JsonlHistoryStore(options)
}

/** 返回 q-code 全局目录，默认 `~/.q-code`。 */
export function getHistoryQCodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.Q_CODE_HOME?.trim() ? resolve(env.Q_CODE_HOME) : join(homedir(), '.q-code')
}

/** 将历史记录格式化为 `/history` 可打印的紧凑列表。 */
export function formatHistoryEntries(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return 'Input history\n\n  还没有可显示的输入历史。'

  const lines = ['Input history', '']
  entries.forEach((entry, index) => {
    const ts = entry.ts.replace('T', ' ').slice(0, 16)
    const scope = entry.scope === 'global' ? 'global' : 'project'
    const marker = entry.redacted ? ' redacted' : ''
    lines.push(
      `${String(index + 1).padStart(2, ' ')}. [${scope}${marker}] ${ts}  ${compactHistoryValue(entry.value)}`
    )
  })
  return lines.join('\n')
}

class JsonlHistoryStore implements HistoryStore {
  private context: HistoryStoreContext
  private readonly env: NodeJS.ProcessEnv
  private readonly qCodeHome?: string
  private readonly now: () => Date
  private readonly explicitSettings?: HistorySettings
  private config: HistoryStoreConfig
  private sessionEnabled = true
  private readonly listeners = new Set<() => void>()

  constructor(options: CreateHistoryStoreOptions) {
    this.context = { cwd: resolve(options.cwd), sessionId: options.sessionId }
    this.env = options.env ?? process.env
    this.qCodeHome = options.qCodeHome
    this.now = options.now ?? (() => new Date())
    this.explicitSettings = options.settings
    this.config = resolveHistoryConfig(this.context.cwd, {
      env: this.env,
      qCodeHome: this.qCodeHome,
      settings: this.explicitSettings
    })
  }

  async load(): Promise<string[]> {
    const entries = await this.loadEntries(this.config.runtimeLimit)
    return entries
      .slice()
      .reverse()
      .map((entry) => entry.value)
  }

  async loadEntries(limit = this.config.runtimeLimit): Promise<HistoryEntry[]> {
    if (this.isDisabled()) return []
    const files = getReadFiles(this.config)
    const loaded = await Promise.all(
      files.map(async (file) => readHistoryEntries(file.path, file.scope, this.config))
    )
    return mergeHistoryEntries(loaded.flat(), limit)
  }

  async search(query: string, limit = 30): Promise<HistoryEntry[]> {
    const trimmed = query.trim()
    if (!trimmed) return this.loadEntries(limit)
    const entries = await this.loadEntries(this.config.runtimeLimit)
    return entries
      .filter((entry) => matchesHistoryValue(entry.value, trimmed, this.config.searchMode))
      .slice(0, limit)
  }

  async append(input: string): Promise<HistoryAppendResult> {
    const evaluation = evaluateInput(input, this.config, this.sessionEnabled)
    if (!evaluation.ok) {
      return { persisted: false, skippedReason: evaluation.reason, paths: [] }
    }

    const files = getWriteFiles(this.config)
    if (files.length === 0) return { persisted: false, skippedReason: 'disabled', paths: [] }

    const entry = createHistoryEntry(evaluation.value, this.context, this.config, this.now())
    const paths: string[] = []
    for (const file of files) {
      const appended = await appendEntry(file.path, file.scope, entry, this.config)
      if (appended) paths.push(file.path)
    }
    if (paths.length > 0) this.notify()
    return { persisted: paths.length > 0, skippedReason: paths.length ? undefined : 'duplicate', paths }
  }

  async clear(scope: HistoryScope = this.config.scope): Promise<void> {
    const files = getFilesForScope(this.config, scope)
    await Promise.all(
      files.map(async (file) => {
        if (!(await isSafeHistoryTarget(file.path, file.scope, this.config, { createDir: true }))) return
        await withFileLock(file.path, async () => {
          if (await isSafeHistoryTarget(file.path, file.scope, this.config, { createDir: true })) {
            await writeTextAtomic(file.path, '')
          }
        })
      })
    )
    this.notify()
  }

  shouldRecord(input: string): boolean {
    return evaluateInput(input, this.config, this.sessionEnabled).ok
  }

  setSessionEnabled(enabled: boolean): void {
    this.sessionEnabled = enabled
  }

  isSessionEnabled(): boolean {
    return this.sessionEnabled
  }

  isDisabled(): boolean {
    return this.config.disabled
  }

  getSearchMode(): HistorySearchMode {
    return this.config.searchMode
  }

  getRuntimeLimit(): number {
    return this.config.runtimeLimit
  }

  getConfig(): HistoryStoreConfig {
    return this.config
  }

  setContext(context: HistoryStoreContext): void {
    this.context = { cwd: resolve(context.cwd), sessionId: context.sessionId }
    this.config = resolveHistoryConfig(this.context.cwd, {
      env: this.env,
      qCodeHome: this.qCodeHome,
      settings: this.explicitSettings
    })
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

function resolveHistoryConfig(
  cwd: string,
  options: {
    env: NodeJS.ProcessEnv
    qCodeHome?: string
    settings?: HistorySettings
  }
): HistoryStoreConfig {
  const qCodeHome = options.qCodeHome ? resolve(options.qCodeHome) : getHistoryQCodeHome(options.env)
  const settings = options.settings ?? readHistorySettings(cwd, qCodeHome)
  const scope = parseScope(options.env.Q_CODE_HISTORY_SCOPE) ?? 'both'
  const searchMode =
    parseSearchMode(options.env.Q_CODE_HISTORY_SEARCH) ?? settings.search ?? 'substring'
  const maxLineBytes = parseBoundedPositiveInt(
    options.env.Q_CODE_HISTORY_MAX_LINE_BYTES,
    DEFAULT_MAX_LINE_BYTES,
    1024,
    HISTORY_MAX_LINE_BYTES_LIMIT
  )
  const maxBytes = Math.max(
    maxLineBytes,
    parseBoundedPositiveInt(
      options.env.Q_CODE_HISTORY_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      1024,
      HISTORY_MAX_BYTES_LIMIT
    )
  )
  const excludePatterns = [
    ...(settings.excludeDefaults === false ? [] : DEFAULT_EXCLUDE_PATTERNS),
    ...(settings.excludePatterns ?? []).flatMap((pattern) => compilePattern(pattern))
  ]

  return {
    disabled: isTrueEnv(options.env.Q_CODE_HISTORY_DISABLED),
    scope,
    redact: isTrueEnv(options.env.Q_CODE_HISTORY_REDACT),
    maxLines: parseBoundedPositiveInt(
      options.env.Q_CODE_HISTORY_MAX_LINES,
      DEFAULT_MAX_LINES,
      1,
      HISTORY_MAX_LINES_LIMIT
    ),
    maxBytes,
    runtimeLimit: parseBoundedPositiveInt(
      options.env.Q_CODE_HISTORY_RUNTIME_LIMIT,
      DEFAULT_RUNTIME_LIMIT,
      1,
      HISTORY_RUNTIME_LIMIT_LIMIT
    ),
    maxLineBytes,
    searchMode,
    excludePatterns,
    cwd: resolve(cwd),
    qCodeHome,
    globalPath: join(qCodeHome, 'history', 'global.jsonl'),
    projectPath: join(resolve(cwd), '.q-code', 'history.jsonl')
  }
}

function readHistorySettings(cwd: string, qCodeHome: string): HistorySettings {
  const result: HistorySettings = {}
  for (const filePath of [join(qCodeHome, 'settings.json'), join(resolve(cwd), '.q-code', 'settings.json')]) {
    const raw = readJsonObject(filePath)
    const history = asRecord(raw?.history)
    if (!history) continue
    const excludePatterns = history.excludePatterns
    if (Array.isArray(excludePatterns)) {
      result.excludePatterns = [
        ...(result.excludePatterns ?? []),
        ...excludePatterns.filter((item): item is string => typeof item === 'string')
      ]
    }
    if (typeof history.excludeDefaults === 'boolean') result.excludeDefaults = history.excludeDefaults
    const search = parseSearchMode(history.search)
    if (search) result.search = search
  }
  return result
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(filePath)) return undefined
    return asRecord(JSON.parse(readFileSync(filePath, 'utf-8')))
  } catch {
    return undefined
  }
}

function evaluateInput(
  input: string,
  config: HistoryStoreConfig,
  sessionEnabled: boolean
): { ok: true; value: string } | { ok: false; reason: string } {
  if (config.disabled) return { ok: false, reason: 'disabled' }
  if (!sessionEnabled) return { ok: false, reason: 'session-disabled' }
  if (input.startsWith(' ')) return { ok: false, reason: 'leading-space' }

  const value = input.trimEnd()
  if (!value.trim()) return { ok: false, reason: 'empty' }
  if (config.excludePatterns.some((pattern) => pattern.test(value))) {
    return { ok: false, reason: 'excluded' }
  }
  return { ok: true, value }
}

function createHistoryEntry(
  value: string,
  context: HistoryStoreContext,
  config: HistoryStoreConfig,
  now: Date
): HistoryEntry {
  const base: HistoryEntry = {
    ts: now.toISOString(),
    sessionId: context.sessionId,
    cwd: context.cwd,
    value,
    chars: value.length
  }

  const entry = config.redact
    ? {
        ...base,
        value: value.slice(0, 40),
        redacted: true,
        sha256: sha256(value)
      }
    : base

  return enforceLineLimit(entry, config.maxLineBytes)
}

function enforceLineLimit(entry: HistoryEntry, maxLineBytes: number): HistoryEntry {
  let next = { ...entry }
  while (Buffer.byteLength(`${JSON.stringify(next)}\n`, 'utf-8') > maxLineBytes && next.value.length > 0) {
    const overflow = Buffer.byteLength(`${JSON.stringify(next)}\n`, 'utf-8') - maxLineBytes
    next = {
      ...next,
      value: next.value.slice(0, Math.max(0, next.value.length - Math.max(1, overflow))),
      truncated: true
    }
  }
  return next
}

async function appendEntry(
  filePath: string,
  scope: Exclude<HistoryScope, 'both'>,
  entry: HistoryEntry,
  config: HistoryStoreConfig
): Promise<boolean> {
  if (!(await isSafeHistoryTarget(filePath, scope, config, { createDir: true }))) return false
  return withFileLock(filePath, async () => {
    if (!(await isSafeHistoryTarget(filePath, scope, config, { createDir: true }))) return false
    const last = await readLastHistoryEntry(filePath)
    if (last && isSameHistoryValue(last, entry)) return false
    await appendHistoryLine(filePath, `${JSON.stringify(stripRuntimeScope(entry))}\n`)
    await rotateHistoryFile(filePath, config)
    return true
  })
}

async function appendHistoryLine(filePath: string, line: string): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | OPEN_NOFOLLOW,
    0o600
  )
  try {
    await handle.writeFile(line, 'utf-8')
  } finally {
    await handle.close()
  }
}

async function rotateHistoryFile(filePath: string, config: HistoryStoreConfig): Promise<void> {
  const current = await readTextOrEmpty(filePath)
  const lines = current.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const currentBytes = Buffer.byteLength(lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8')
  if (lines.length <= config.maxLines && currentBytes <= config.maxBytes) return

  const kept = lines.slice(-config.maxLines)
  while (kept.length > 0 && Buffer.byteLength(`${kept.join('\n')}\n`, 'utf-8') > config.maxBytes) {
    kept.shift()
  }
  await writeTextAtomic(filePath, kept.length > 0 ? `${kept.join('\n')}\n` : '')
}

async function readHistoryEntries(
  filePath: string,
  scope: Exclude<HistoryScope, 'both'>,
  config?: HistoryStoreConfig
): Promise<HistoryEntry[]> {
  if (config && !(await isSafeHistoryTarget(filePath, scope, config, { createDir: false }))) return []
  const text = await readTextOrEmpty(filePath)
  if (!text) return []
  return text
    .split(/\r?\n/)
    .flatMap((line) => parseHistoryLine(line, scope))
}

async function readLastHistoryEntry(filePath: string): Promise<HistoryEntry | undefined> {
  const text = await readTextOrEmpty(filePath)
  if (!text) return undefined
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseHistoryLine(lines[index] ?? '', 'project')[0]
    if (parsed) return parsed
  }
  return undefined
}

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch (error) {
    if (isNotFoundError(error)) return ''
    throw error
  }
}

function parseHistoryLine(line: string, scope: Exclude<HistoryScope, 'both'>): HistoryEntry[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  try {
    const raw = JSON.parse(trimmed) as unknown
    const record = asRecord(raw)
    if (!record) return []
    if (
      typeof record.ts !== 'string' ||
      typeof record.sessionId !== 'string' ||
      typeof record.cwd !== 'string' ||
      typeof record.value !== 'string' ||
      typeof record.chars !== 'number'
    ) {
      return []
    }
    return [
      {
        ts: record.ts,
        sessionId: record.sessionId,
        cwd: record.cwd,
        value: record.value,
        chars: record.chars,
        ...(record.truncated === true ? { truncated: true } : {}),
        ...(record.redacted === true ? { redacted: true } : {}),
        ...(typeof record.sha256 === 'string' ? { sha256: record.sha256 } : {}),
        scope
      }
    ]
  } catch {
    return []
  }
}

function mergeHistoryEntries(entries: HistoryEntry[], limit: number): HistoryEntry[] {
  const sorted = entries
    .slice()
    .sort((a, b) => compareHistoryTimeDesc(a, b) || compareScope(a.scope, b.scope))
  const seen = new Set<string>()
  const merged: HistoryEntry[] = []
  for (const entry of sorted) {
    const key = entry.sha256 ?? entry.value
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
    if (merged.length >= limit) break
  }
  return merged
}

function isSameHistoryValue(a: HistoryEntry, b: HistoryEntry): boolean {
  if (a.sha256 && b.sha256) return a.sha256 === b.sha256
  return a.value === b.value
}

function compareHistoryTimeDesc(a: HistoryEntry, b: HistoryEntry): number {
  return safeTime(b.ts) - safeTime(a.ts)
}

function compareScope(
  a: Exclude<HistoryScope, 'both'> | undefined,
  b: Exclude<HistoryScope, 'both'> | undefined
): number {
  return scopeRank(a) - scopeRank(b)
}

function scopeRank(scope: Exclude<HistoryScope, 'both'> | undefined): number {
  return scope === 'project' ? 0 : 1
}

function safeTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

function getReadFiles(config: HistoryStoreConfig): Array<{ path: string; scope: Exclude<HistoryScope, 'both'> }> {
  return getFilesForScope(config, config.scope)
}

function getWriteFiles(config: HistoryStoreConfig): Array<{ path: string; scope: Exclude<HistoryScope, 'both'> }> {
  return getFilesForScope(config, config.scope)
}

function getFilesForScope(
  config: HistoryStoreConfig,
  scope: HistoryScope
): Array<{ path: string; scope: Exclude<HistoryScope, 'both'> }> {
  if (scope === 'global') return [{ path: config.globalPath, scope: 'global' }]
  if (scope === 'project') return [{ path: config.projectPath, scope: 'project' }]
  return [
    { path: config.projectPath, scope: 'project' },
    { path: config.globalPath, scope: 'global' }
  ]
}

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`
  await mkdir(dirname(filePath), { recursive: true })
  const handle = await acquireLock(lockPath)
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

async function isSafeHistoryTarget(
  filePath: string,
  scope: Exclude<HistoryScope, 'both'>,
  config: HistoryStoreConfig,
  options: { createDir: boolean }
): Promise<boolean> {
  const dir = dirname(filePath)
  if (options.createDir) await mkdir(dir, { recursive: true })
  if (await isSymlink(filePath)) return false
  if (scope !== 'project') return true

  try {
    const [root, targetDir] = await Promise.all([realpath(config.cwd), realpath(dir)])
    return isPathInside(targetDir, root)
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw error
  }
}

async function isSymlink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink()
  } catch (error) {
    if (isNotFoundError(error)) return false
    throw error
  }
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const target = resolve(targetPath)
  const root = resolve(rootPath)
  return target === root || target.startsWith(`${root}${sep}`)
}

async function acquireLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      return await open(lockPath, 'wx')
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error
      await removeStaleLock(lockPath)
      await sleep(LOCK_RETRY_DELAY_MS)
    }
  }
  throw new Error(`input history lock timed out: ${lockPath}`)
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath)
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(lockPath, { force: true })
  } catch {
    // 锁文件消失或无法读取时交给下一次 open 重试。
  }
}

function stripRuntimeScope(entry: HistoryEntry): HistoryEntry {
  const { scope: _scope, ...serializable } = entry
  return serializable
}

function matchesHistoryValue(value: string, query: string, mode: HistorySearchMode): boolean {
  const candidate = value.toLowerCase()
  const normalizedQuery = query.toLowerCase()
  if (mode === 'substring') return candidate.includes(normalizedQuery)
  let cursor = 0
  for (const char of normalizedQuery) {
    cursor = candidate.indexOf(char, cursor)
    if (cursor === -1) return false
    cursor += 1
  }
  return true
}

function compactHistoryValue(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  return singleLine.length > 100 ? `${singleLine.slice(0, 99)}…` : singleLine
}

function compilePattern(pattern: string): RegExp[] {
  try {
    return [new RegExp(pattern, 'i')]
  } catch {
    return []
  }
}

function parseScope(value: unknown): HistoryScope | undefined {
  if (value !== 'global' && value !== 'project' && value !== 'both') return undefined
  return value
}

function parseSearchMode(value: unknown): HistorySearchMode | undefined {
  if (value !== 'substring' && value !== 'fuzzy') return undefined
  return value
}

function parseBoundedPositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min) return fallback
  return Math.min(parsed, max)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isNotFoundError(error: unknown): boolean {
  return asRecord(error)?.code === 'ENOENT'
}

function isAlreadyExistsError(error: unknown): boolean {
  return asRecord(error)?.code === 'EEXIST'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
