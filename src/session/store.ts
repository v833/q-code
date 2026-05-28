/**
 * 会话持久化：按项目目录下的 JSONL append-only 转录（transcript）。
 *
 * 支持 `--continue`（latest 指针）、旧版 `default.jsonl` 迁移、压缩快照、
 * usage/cache/tool 事件与恢复时跳过已持久化消息前缀。
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { ModelMessage } from 'ai'
import { PROJECTS_DIR, getProjectStorageInfo, type ProjectStorageInfo } from '../context/project-paths'
import type { TokenUsage } from '../context/token-budget'
import type { CacheMode, NormalizedUsage, UsageCost, UsageRecord, UsageTotals } from '../usage'

const LATEST_FILE = 'latest'
const LEGACY_DEFAULT_SESSION_ID = 'default'
const TRASH_DIR = '.trash'
const EXPORTS_DIR = 'exports'
const META_EXTENSION = '.meta.json'
const JSONL_EXTENSION = '.jsonl'

/** 上下文压缩写入 transcript 时的触发来源。 */
export type CompactionTrigger = 'startup' | 'preflight' | 'post-turn' | 'manual'

/** `SessionStore` 构造选项。 */
export interface SessionStoreOptions {
  /** 项目工作目录，默认 `process.cwd()` */
  cwd?: string
  /** 显式会话 ID；缺省时由 continue/latest/新建 UUID 决定 */
  sessionId?: string
  /** 为 true 时读取 `latest` 指针续接最近会话 */
  continueLatest?: boolean
  /** 覆盖默认 `.sessions` 根目录（`Q_CODE_SESSION_DIR` 同级语义） */
  sessionDir?: string
}

/** 当前会话在磁盘上的路径集合。 */
export interface SessionPaths {
  rootDir: string
  projectDir: string
  latestPath: string
  transcriptPath: string
  metaPath: string
  trashDir: string
  exportsDir: string
  /** 旧版根目录下的 `default.jsonl` */
  legacyTranscriptPath: string
}

/** `.meta.json` 中保存的会话展示与索引字段。 */
export interface SessionMetadata {
  sessionId: string
  displayName?: string
  createdAt: string
  updatedAt: string
  messageCount: number
  totalTokens: number
  lastUserPromptDigest?: string
  model?: string
  tags: string[]
  cwd?: string
  projectKey?: string
}

/** 列表/摘要视图中的会话元信息。 */
export interface SessionSummary {
  sessionId: string
  cwd: string
  projectKey: string
  transcriptPath: string
  metaPath: string
  displayName?: string
  startedAt?: string
  updatedAt?: string
  messageCount: number
  totalTokens?: number
  lastUserPromptDigest?: string
  model?: string
  tags: string[]
  trashed?: boolean
  totalUsage?: TokenUsage
  usageTotals?: UsageTotals
}

/** 会话导出格式。 */
export type SessionExportFormat = 'md' | 'json' | 'html'

/** 会话导出结果。 */
export interface SessionExportResult {
  sessionId: string
  format: SessionExportFormat
  outPath: string
  bytes: number
}

/** 会话搜索匹配项。 */
export interface SessionSearchMatch {
  sessionId: string
  displayName?: string
  projectKey: string
  transcriptPath: string
  timestamp: string
  role: string
  snippet: string
}

/** 会话清理结果。 */
export interface SessionPurgeResult {
  candidates: SessionSummary[]
  deleted: SessionSummary[]
}

interface TranscriptSummary {
  sessionId: string
  cwd: string
  projectKey: string
  transcriptPath: string
  startedAt?: string
  updatedAt?: string
  messageCount: number
  totalUsage?: TokenUsage
  usageTotals?: UsageTotals
}

/** JSONL 单行事件：元数据、消息、用量、压缩、工具事件等。 */
export type TranscriptEntry =
  | {
      type: 'session_meta'
      timestamp: string
      sessionId: string
      cwd: string
      projectKey: string
      schemaVersion: 2
    }
  | {
      type: 'message'
      timestamp: string
      message: ModelMessage
    }
  | {
      type: 'usage'
      timestamp: string
      turn: TokenUsage
      total: TokenUsage
    }
  | {
      type: 'usage_v2'
      timestamp: string
      record: UsageRecord
      totals?: UsageTotals
    }
  | {
      type: 'cache_mode'
      timestamp: string
      mode: CacheMode
    }
  | {
      type: 'tool_event'
      timestamp: string
      phase: 'start' | 'done'
      name: string
      toolCallId?: string
      resultLength?: number
      isError?: boolean
    }
  | {
      type: 'compaction'
      timestamp: string
      trigger: CompactionTrigger
      beforeTokens: number
      afterTokens: number
      messageCount: number
    }

/**
 * 单会话 JSONL 存储：追加写入、按最后一次 compaction 恢复活跃消息。
 */
export class SessionStore {
  readonly sessionId: string
  readonly cwd: string
  readonly projectKey: string
  readonly paths: SessionPaths
  private readonly existedBeforeInit: boolean

  /**
   * 打开或创建会话；新会话写入 `session_meta` 行并更新 `latest`。
   *
   * @param options - 配置对象，或仅传 `sessionId` 字符串
   */
  constructor(options: SessionStoreOptions | string = {}) {
    const normalizedOptions = normalizeOptions(options)
    const storage = getProjectStorageInfo(normalizedOptions.cwd ?? process.cwd(), normalizedOptions.sessionDir)

    this.cwd = storage.cwd
    this.projectKey = storage.projectKey
    const requestedSessionId = normalizeSessionId(normalizedOptions.sessionId)
    const latestSessionId = normalizedOptions.continueLatest
      ? readLatestSessionId(storage.rootDir, this.projectKey)
      : null
    const fallbackSessionId =
      normalizedOptions.continueLatest && hasLegacyDefaultSession(storage.rootDir)
        ? LEGACY_DEFAULT_SESSION_ID
        : null

    this.sessionId = requestedSessionId ?? latestSessionId ?? fallbackSessionId ?? createSessionId()
    this.paths = getSessionPaths(storage, this.sessionId)

    ensureProjectDir(this.paths)
    migrateLegacyDefaultSession(storage.rootDir, this.paths, this.sessionId)

    this.existedBeforeInit = existsSync(this.paths.transcriptPath)
    if (!this.existedBeforeInit) {
      this.appendEntry({
        type: 'session_meta',
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        cwd: this.cwd,
        projectKey: this.projectKey,
        schemaVersion: 2
      })
    } else {
      writeLatestSessionId(this.paths, this.sessionId)
      this.refreshMetadata()
    }
  }

  /** 追加一条对话消息。 */
  append(message: ModelMessage): void {
    this.appendEntry({
      type: 'message',
      timestamp: new Date().toISOString(),
      message
    })
  }

  /** 顺序追加多条消息。 */
  appendAll(messages: ModelMessage[]): void {
    for (const message of messages) this.append(message)
  }

  /**
   * 仅追加尚未出现在 transcript 活跃视图中的消息后缀。
   *
   * 压缩快照可能已整段写入；agent loop 续写时避免重复持久化相同前缀。
   */
  appendUnpersisted(messages: ModelMessage[]): void {
    const persisted = this.load()
    const alreadyStored = countPersistedPrefix(persisted, messages)
    for (const message of messages.slice(alreadyStored)) this.append(message)
  }

  /** 追加 v1 用量行（turn + 累计 total）。 */
  appendUsage(turn: TokenUsage, total: TokenUsage): void {
    this.appendEntry({
      type: 'usage',
      timestamp: new Date().toISOString(),
      turn,
      total
    })
  }

  /** 追加 v2 用量行（含归一化 usage 与可选 totals）。 */
  appendUsageV2(record: UsageRecord, totals: UsageTotals): void {
    this.appendEntry({
      type: 'usage_v2',
      timestamp: new Date().toISOString(),
      record,
      totals
    })
  }

  /** 记录 prompt cache 模式切换。 */
  appendCacheMode(mode: CacheMode): void {
    this.appendEntry({
      type: 'cache_mode',
      timestamp: new Date().toISOString(),
      mode
    })
  }

  /** 记录工具 start/done 事件（TUI 回放用）。 */
  appendToolEvent(event: Omit<Extract<TranscriptEntry, { type: 'tool_event' }>, 'timestamp'>): void {
    this.appendEntry({
      ...event,
      timestamp: new Date().toISOString()
    })
  }

  /**
   * 写入压缩元数据并批量追加压缩后的消息快照。
   *
   * `load()` 仅返回最后一次 compaction 之后的 `message` 行。
   */
  appendCompactionSnapshot(params: {
    trigger: CompactionTrigger
    beforeTokens: number
    afterTokens: number
    messages: ModelMessage[]
  }): void {
    const now = new Date().toISOString()
    const entries: TranscriptEntry[] = [
      {
        type: 'compaction',
        timestamp: now,
        trigger: params.trigger,
        beforeTokens: params.beforeTokens,
        afterTokens: params.afterTokens,
        messageCount: params.messages.length
      },
      ...params.messages.map((message) => ({
        type: 'message' as const,
        timestamp: now,
        message
      }))
    ]

    this.appendEntries(entries)
  }

  /** 读取当前活跃上下文中的消息（忽略 compaction 之前的历史）。 */
  load(): ModelMessage[] {
    const entries = this.readEntries()
    const lastCompactionIndex = findLastCompactionIndex(entries)
    const activeEntries =
      lastCompactionIndex >= 0 ? entries.slice(lastCompactionIndex + 1) : entries

    return activeEntries
      .filter((entry): entry is Extract<TranscriptEntry, { type: 'message' }> => {
        return entry.type === 'message'
      })
      .map((entry) => entry.message)
  }

  /** 构造时 transcript 文件是否已存在（区分新建 vs 续接）。 */
  exists(): boolean {
    return this.existedBeforeInit
  }

  /** 从 transcript 聚合会话摘要。 */
  getSummary(): SessionSummary {
    const entries = this.readEntries()
    return summarizeSession({
      sessionId: this.sessionId,
      cwd: this.cwd,
      projectKey: this.projectKey,
      transcriptPath: this.paths.transcriptPath,
      metaPath: this.paths.metaPath,
      entries
    })
  }

  /** 读取或回填当前会话 metadata。 */
  getMetadata(): SessionMetadata {
    return this.refreshMetadata()
  }

  /** 更新当前会话可展示字段。 */
  updateMetadata(patch: Partial<Pick<SessionMetadata, 'displayName' | 'model' | 'tags'>>): SessionMetadata {
    const current = this.refreshMetadata()
    const next: SessionMetadata = {
      ...current,
      ...(patch.displayName !== undefined ? { displayName: normalizeOptionalString(patch.displayName) } : {}),
      ...(patch.model !== undefined ? { model: normalizeOptionalString(patch.model) } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags.map((tag) => tag.trim()).filter(Boolean) } : {}),
      updatedAt: new Date().toISOString()
    }
    writeJsonFile(this.paths.metaPath, next)
    return next
  }

  /** 返回全部 `usage_v2` 记录（按文件顺序）。 */
  getUsageRecords(): UsageRecord[] {
    return this.readEntries()
      .filter((entry): entry is Extract<TranscriptEntry, { type: 'usage_v2' }> => {
        return entry.type === 'usage_v2'
      })
      .map((entry) => entry.record)
  }

  /** 返回 transcript 中最后一次 `cache_mode`（若无则 undefined）。 */
  getLatestCacheMode(): CacheMode | undefined {
    return [...this.readEntries()]
      .reverse()
      .find((entry): entry is Extract<TranscriptEntry, { type: 'cache_mode' }> => {
        return entry.type === 'cache_mode'
      })?.mode
  }

  private appendEntry(entry: TranscriptEntry): void {
    this.appendEntries([entry])
  }

  private appendEntries(entries: TranscriptEntry[]): void {
    if (entries.length === 0) return

    // JSONL 选择 append-only 写入：每个事件一行，崩溃时最多损坏末尾一行；
    // 恢复时逐行解析并跳过坏行，比整份 JSON 文件更适合长会话。
    const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    appendFileSync(this.paths.transcriptPath, lines, 'utf-8')
    writeLatestSessionId(this.paths, this.sessionId)
    this.refreshMetadata()
  }

  private readEntries(): TranscriptEntry[] {
    return readEntriesFromPath(this.paths.transcriptPath)
  }

  private refreshMetadata(): SessionMetadata {
    const entries = this.readEntries()
    const summary = summarizeTranscript({
      sessionId: this.sessionId,
      cwd: this.cwd,
      projectKey: this.projectKey,
      transcriptPath: this.paths.transcriptPath,
      entries
    })
    const previous = readMetadata(this.paths.metaPath)
    const metadata = buildMetadata({
      previous,
      summary,
      entries,
      cwd: this.cwd,
      projectKey: this.projectKey
    })
    writeJsonFile(this.paths.metaPath, metadata)
    return metadata
  }
}

/** 生成新的 UUID 会话 ID。 */
export function createSessionId(): string {
  return randomUUID()
}

/**
 * 列出当前项目目录下所有 `.jsonl` 会话文件摘要，按 `updatedAt` 降序。
 *
 * @param options - `cwd` / `sessionDir` 与 `SessionStore` 一致
 */
export function listProjectSessions(options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> = {}): SessionSummary[] {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  return listSessionsInProject(storage)
}

/**
 * 快速列出当前项目会话（避免读取/解析 transcript）。
 *
 * 用于 TUI 列表首屏渲染：优先使用 `.meta.json`，否则退化为文件系统时间戳与最小字段，
 * 以避免大量 `readFileSync + JSON.parse` 阻塞事件循环导致界面卡死。
 */
export function listProjectSessionsFast(
  options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> = {}
): SessionSummary[] {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  return listSessionsInProject(storage, { eagerReadTranscript: false })
}

/** 列出存储根下所有项目的会话。 */
export function listAllSessions(options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> = {}): SessionSummary[] {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  const projectsDir = join(storage.rootDir, PROJECTS_DIR)
  if (!existsSync(projectsDir)) return []
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      listSessionsInProject({
        ...storage,
        projectKey: entry.name,
        projectDir: join(projectsDir, entry.name)
      })
    )
    .sort(sortSessionsByUpdatedAt)
}

/** 快速列出跨项目会话（避免读取/解析 transcript）。 */
export function listAllSessionsFast(options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> = {}): SessionSummary[] {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  const projectsDir = join(storage.rootDir, PROJECTS_DIR)
  if (!existsSync(projectsDir)) return []
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      listSessionsInProject(
        {
          ...storage,
          projectKey: entry.name,
          projectDir: join(projectsDir, entry.name)
        },
        { eagerReadTranscript: false }
      )
    )
    .sort(sortSessionsByUpdatedAt)
}

/** 返回单个会话详情，默认不含 trash。 */
export function getSessionSummary(
  sessionId: string,
  options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> & { includeTrash?: boolean } = {}
): SessionSummary | undefined {
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!normalizedSessionId) return undefined
  return listSessionsInProject(getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir), {
    includeTrash: options.includeTrash
  }).find((session) => session.sessionId === normalizedSessionId)
}

/** 修改会话展示名称。 */
export function renameSession(
  sessionId: string,
  displayName: string,
  options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> = {}
): SessionMetadata {
  const normalizedSessionId = requireSessionId(sessionId)
  const summary = getSessionSummary(normalizedSessionId, options)
  if (!summary) throw new Error(`Session not found: ${normalizedSessionId}`)

  const store = new SessionStore({ ...options, sessionId: normalizedSessionId })
  return store.updateMetadata({ displayName })
}

/** 软删到 trash，或 force 物理删除。 */
export function deleteSession(
  sessionId: string,
  options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> & { force?: boolean } = {}
): SessionSummary {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  const normalizedSessionId = requireSessionId(sessionId)
  const paths = getSessionPaths(storage, normalizedSessionId)
  const summary = getSessionSummary(normalizedSessionId, {
    cwd: options.cwd,
    sessionDir: options.sessionDir,
    includeTrash: options.force
  })
  if (!summary) throw new Error(`Session not found: ${normalizedSessionId}`)

  if (options.force) {
    rmIfExists(paths.transcriptPath)
    rmIfExists(paths.metaPath)
    rmSync(join(paths.trashDir, normalizedSessionId), { recursive: true, force: true })
    return summary
  }

  mkdirSync(join(paths.trashDir, normalizedSessionId), { recursive: true })
  moveIfExists(paths.transcriptPath, join(paths.trashDir, normalizedSessionId, basename(paths.transcriptPath)))
  moveIfExists(paths.metaPath, join(paths.trashDir, normalizedSessionId, basename(paths.metaPath)))
  return { ...summary, trashed: true }
}

/** 从 trash 恢复会话。 */
export function restoreSession(
  sessionId: string,
  options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> = {}
): SessionSummary {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  const normalizedSessionId = requireSessionId(sessionId)
  const paths = getSessionPaths(storage, normalizedSessionId)
  const trashSessionDir = join(paths.trashDir, normalizedSessionId)
  const trashedSummary = getTrashedSessionSummary(storage, normalizedSessionId)
  if (!trashedSummary) throw new Error(`Trashed session not found: ${normalizedSessionId}`)
  if (existsSync(paths.transcriptPath)) throw new Error(`Session already exists: ${normalizedSessionId}`)

  ensureProjectDir(paths)
  moveIfExists(join(trashSessionDir, basename(paths.transcriptPath)), paths.transcriptPath)
  moveIfExists(join(trashSessionDir, basename(paths.metaPath)), paths.metaPath)
  rmSync(trashSessionDir, { recursive: true, force: true })
  const store = new SessionStore({ ...options, sessionId: normalizedSessionId })
  return store.getSummary()
}

/** 清理 trash 中超过指定天数的会话；未 confirm 时只返回候选。 */
export function purgeSessions(
  options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> & { olderThanDays?: number; confirm?: boolean } = {}
): SessionPurgeResult {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  const olderThanDays = options.olderThanDays ?? 30
  const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  const candidates = listTrashedSessionsInProject(storage).filter((session) => {
    const updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : 0
    return !Number.isFinite(updatedAt) || updatedAt <= threshold
  })
  if (!options.confirm) return { candidates, deleted: [] }

  for (const session of candidates) {
    rmSync(join(storage.projectDir, TRASH_DIR, session.sessionId), { recursive: true, force: true })
  }
  return { candidates, deleted: candidates }
}

/** 导出会话为 markdown/json/html。 */
export function exportSession(
  sessionId: string,
  options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> & {
    format?: SessionExportFormat
    outPath?: string
  } = {}
): SessionExportResult {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  const normalizedSessionId = requireSessionId(sessionId)
  const paths = getSessionPaths(storage, normalizedSessionId)
  const entries = readEntriesFromPath(paths.transcriptPath)
  if (entries.length === 0 && !existsSync(paths.transcriptPath)) {
    throw new Error(`Session not found: ${normalizedSessionId}`)
  }
  const summary = summarizeSession({
    cwd: storage.cwd,
    projectKey: storage.projectKey,
    sessionId: normalizedSessionId,
    transcriptPath: paths.transcriptPath,
    metaPath: paths.metaPath,
    entries
  })
  const format = options.format ?? 'md'
  const content = renderSessionExport(format, summary, entries, readMetadata(paths.metaPath))
  const outPath = resolveExportPath({
    requestedPath: options.outPath,
    cwd: storage.cwd,
    exportsDir: paths.exportsDir,
    sessionId: normalizedSessionId,
    displayName: summary.displayName,
    format
  })
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content, 'utf-8')
  return {
    sessionId: normalizedSessionId,
    format,
    outPath,
    bytes: Buffer.byteLength(content)
  }
}

/** 在会话 JSONL 文本中搜索 user/assistant/tool/system 内容。 */
export function searchSessions(
  keyword: string,
  options: Pick<SessionStoreOptions, 'cwd' | 'sessionDir'> & {
    allProjects?: boolean
    includeTrash?: boolean
    limit?: number
  } = {}
): SessionSearchMatch[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return []
  const sessions = options.allProjects
    ? listAllSessions(options)
    : listSessionsInProject(getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir), {
        includeTrash: options.includeTrash
      })
  const matches: SessionSearchMatch[] = []
  for (const session of sessions) {
    if (session.trashed && !options.includeTrash) continue
    for (const entry of readEntriesFromPath(session.transcriptPath)) {
      if (entry.type !== 'message') continue
      const text = modelMessageToText(entry.message)
      const index = text.toLowerCase().indexOf(needle)
      if (index < 0) continue
      matches.push({
        sessionId: session.sessionId,
        displayName: session.displayName,
        projectKey: session.projectKey,
        transcriptPath: session.transcriptPath,
        timestamp: entry.timestamp,
        role: entry.message.role,
        snippet: makeSnippet(text, index, keyword.length)
      })
      if (matches.length >= (options.limit ?? 100)) return matches
    }
  }
  return matches
}

function normalizeOptions(options: SessionStoreOptions | string): SessionStoreOptions {
  return typeof options === 'string' ? { sessionId: options } : options
}

function listSessionsInProject(
  storage: ProjectStorageInfo,
  options: { includeTrash?: boolean; eagerReadTranscript?: boolean } = {}
): SessionSummary[] {
  if (!existsSync(storage.projectDir)) return []
  const eagerReadTranscript = options.eagerReadTranscript ?? true
  const active = readdirSync(storage.projectDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(JSONL_EXTENSION))
    .map((entry) =>
      buildSessionSummaryFromPaths({
        storage,
        sessionId: entry.name.slice(0, -JSONL_EXTENSION.length),
        transcriptPath: join(storage.projectDir, entry.name),
        metaPath: join(storage.projectDir, `${entry.name.slice(0, -JSONL_EXTENSION.length)}${META_EXTENSION}`),
        eagerReadTranscript
      })
    )
  const trashed = options.includeTrash ? listTrashedSessionsInProject(storage) : []
  return [...active, ...trashed].sort(sortSessionsByUpdatedAt)
}

function listTrashedSessionsInProject(storage: ProjectStorageInfo): SessionSummary[] {
  const trashDir = join(storage.projectDir, TRASH_DIR)
  if (!existsSync(trashDir)) return []
  return readdirSync(trashDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const sessionId = entry.name
      const sessionTrashDir = join(trashDir, sessionId)
      return buildSessionSummaryFromPaths({
        storage,
        sessionId,
        transcriptPath: join(sessionTrashDir, `${sessionId}${JSONL_EXTENSION}`),
        metaPath: join(sessionTrashDir, `${sessionId}${META_EXTENSION}`),
        trashed: true,
        eagerReadTranscript: true
      })
    })
    .sort(sortSessionsByUpdatedAt)
}

function getTrashedSessionSummary(storage: ProjectStorageInfo, sessionId: string): SessionSummary | undefined {
  return listTrashedSessionsInProject(storage).find((session) => session.sessionId === sessionId)
}

function buildSessionSummaryFromPaths(params: {
  storage: ProjectStorageInfo
  sessionId: string
  transcriptPath: string
  metaPath: string
  trashed?: boolean
  eagerReadTranscript?: boolean
}): SessionSummary {
  const metadata = readMetadata(params.metaPath)
  if (metadata && shouldUseMetadataFastPath(params, metadata)) {
    return summarizeSessionFromMetadata(params, metadata)
  }

  const eagerReadTranscript = params.eagerReadTranscript ?? true
  if (!eagerReadTranscript) {
    return summarizeSessionFromFilesystem(params, metadata)
  }

  const entries = readEntriesFromPath(params.transcriptPath)
  const summary = summarizeSession({
    cwd: params.storage.cwd,
    projectKey: params.storage.projectKey,
    sessionId: params.sessionId,
    transcriptPath: params.transcriptPath,
    metaPath: params.metaPath,
    entries,
    trashed: params.trashed
  })
  if (!params.trashed) {
    const metadata = buildMetadata({
      previous: readMetadata(params.metaPath),
      summary,
      entries,
      cwd: params.storage.cwd,
      projectKey: params.storage.projectKey
    })
    writeJsonFile(params.metaPath, metadata)
    return { ...summary, ...metadataToSummaryFields(metadata) }
  }
  return summary
}

function summarizeSessionFromFilesystem(
  params: {
    storage: ProjectStorageInfo
    sessionId: string
    transcriptPath: string
    metaPath: string
    trashed?: boolean
  },
  metadata: SessionMetadata | undefined
): SessionSummary {
  const updatedAt = metadata?.updatedAt ?? fileMtimeIso(params.transcriptPath)
  const startedAt = metadata?.createdAt ?? fileBirthIso(params.transcriptPath) ?? updatedAt

  return {
    sessionId: params.sessionId,
    cwd: metadata?.cwd ?? params.storage.cwd,
    projectKey: metadata?.projectKey ?? params.storage.projectKey,
    transcriptPath: params.transcriptPath,
    metaPath: params.metaPath,
    startedAt,
    updatedAt,
    messageCount: metadata?.messageCount ?? 0,
    totalTokens: metadata?.totalTokens ?? 0,
    ...(metadata?.displayName ? { displayName: metadata.displayName } : {}),
    ...(metadata?.lastUserPromptDigest ? { lastUserPromptDigest: metadata.lastUserPromptDigest } : {}),
    ...(metadata?.model ? { model: metadata.model } : {}),
    tags: metadata?.tags ?? [],
    ...(params.trashed ? { trashed: true } : {})
  }
}

function shouldUseMetadataFastPath(
  params: {
    sessionId: string
    transcriptPath: string
    metaPath: string
    trashed?: boolean
  },
  metadata: SessionMetadata
): boolean {
  if (metadata.sessionId !== params.sessionId) return false
  const metaMtime = fileMtimeMs(params.metaPath)
  const transcriptMtime = fileMtimeMs(params.transcriptPath)
  if (transcriptMtime === undefined) return params.trashed === true
  return metaMtime !== undefined && metaMtime >= transcriptMtime
}

function summarizeSessionFromMetadata(
  params: {
    storage: ProjectStorageInfo
    sessionId: string
    transcriptPath: string
    metaPath: string
    trashed?: boolean
  },
  metadata: SessionMetadata
): SessionSummary {
  return {
    sessionId: params.sessionId,
    cwd: metadata.cwd ?? params.storage.cwd,
    projectKey: metadata.projectKey ?? params.storage.projectKey,
    transcriptPath: params.transcriptPath,
    metaPath: params.metaPath,
    startedAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    messageCount: metadata.messageCount,
    totalTokens: metadata.totalTokens,
    ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
    ...(metadata.lastUserPromptDigest ? { lastUserPromptDigest: metadata.lastUserPromptDigest } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    tags: metadata.tags,
    ...(params.trashed ? { trashed: true } : {})
  }
}

function sortSessionsByUpdatedAt(a: SessionSummary, b: SessionSummary): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
}

function getSessionPaths(storage: ProjectStorageInfo, sessionId: string): SessionPaths {
  return {
    rootDir: storage.rootDir,
    projectDir: storage.projectDir,
    latestPath: join(storage.projectDir, LATEST_FILE),
    transcriptPath: join(storage.projectDir, `${sessionId}.jsonl`),
    metaPath: join(storage.projectDir, `${sessionId}${META_EXTENSION}`),
    trashDir: join(storage.projectDir, TRASH_DIR),
    exportsDir: join(storage.projectDir, EXPORTS_DIR),
    legacyTranscriptPath: join(storage.rootDir, `${LEGACY_DEFAULT_SESSION_ID}.jsonl`)
  }
}

function ensureProjectDir(paths: SessionPaths): void {
  mkdirSync(paths.projectDir, { recursive: true })
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`Invalid session id: ${sessionId}`)
  }
  return sessionId
}

function requireSessionId(sessionId: string): string {
  const normalized = normalizeSessionId(sessionId.trim())
  if (!normalized) throw new Error('Session id is required')
  return normalized
}

function readLatestSessionId(rootDir: string, projectKey: string): string | null {
  const latestPath = join(rootDir, PROJECTS_DIR, projectKey, LATEST_FILE)
  if (!existsSync(latestPath)) return null

  let sessionId: string | undefined
  try {
    sessionId = normalizeSessionId(readFileSync(latestPath, 'utf-8').trim())
  } catch {
    // latest 是可恢复的本地指针文件，损坏时忽略它并走后续 fallback，
    // 不应因为一个状态文件阻塞整个 CLI 启动。
    return null
  }
  if (!sessionId) return null

  const transcriptPath = join(rootDir, PROJECTS_DIR, projectKey, `${sessionId}.jsonl`)
  return existsSync(transcriptPath) ? sessionId : null
}

function writeLatestSessionId(paths: SessionPaths, sessionId: string): void {
  writeFileSync(paths.latestPath, `${sessionId}\n`, 'utf-8')
}

function hasLegacyDefaultSession(rootDir: string): boolean {
  return existsSync(join(rootDir, `${LEGACY_DEFAULT_SESSION_ID}.jsonl`))
}

function migrateLegacyDefaultSession(
  rootDir: string,
  paths: SessionPaths,
  sessionId: string
): void {
  if (sessionId !== LEGACY_DEFAULT_SESSION_ID) return
  if (!existsSync(paths.legacyTranscriptPath) || existsSync(paths.transcriptPath)) return

  // 旧版本把所有项目都写进 .sessions/default.jsonl。这里复制到项目目录，
  // 保留原文件不动，既让 --continue 能续上旧历史，也避免破坏用户数据。
  copyFileSync(paths.legacyTranscriptPath, paths.transcriptPath)
}

function findLastCompactionIndex(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === 'compaction') return i
  }
  return -1
}

function countPersistedPrefix(persisted: ModelMessage[], incoming: ModelMessage[]): number {
  const maxOverlap = Math.min(persisted.length, incoming.length)

  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    const persistedTail = persisted.slice(persisted.length - overlap)
    const incomingHead = incoming.slice(0, overlap)
    if (sameMessages(persistedTail, incomingHead)) return overlap
  }

  return 0
}

function sameMessages(left: ModelMessage[], right: ModelMessage[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (stableStringify(left[i]) !== stableStringify(right[i])) return false
  }
  return true
}

function getLastTimestamp(entries: TranscriptEntry[]): string | undefined {
  return [...entries]
    .reverse()
    .find((entry): entry is TranscriptEntry & { timestamp: string } => typeof entry.timestamp === 'string')
    ?.timestamp
}

function summarizeTranscript(params: {
  cwd: string
  projectKey: string
  sessionId: string
  transcriptPath: string
  entries: TranscriptEntry[]
}): TranscriptSummary {
  const meta = params.entries.find(
    (entry): entry is Extract<TranscriptEntry, { type: 'session_meta' }> =>
      entry.type === 'session_meta'
  )
  const latestUsage = [...params.entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: 'usage' }> => entry.type === 'usage')
  const latestUsageV2 = [...params.entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: 'usage_v2' }> => entry.type === 'usage_v2')

  return {
    sessionId: params.sessionId,
    cwd: meta?.cwd || params.cwd,
    projectKey: meta?.projectKey || params.projectKey,
    transcriptPath: params.transcriptPath,
    startedAt: meta?.timestamp,
    updatedAt: getLastTimestamp(params.entries),
    messageCount: params.entries.filter((entry) => entry.type === 'message').length,
    totalUsage: latestUsage?.total,
    ...(latestUsageV2?.totals ? { usageTotals: latestUsageV2.totals } : {})
  }
}

function summarizeSession(params: {
  cwd: string
  projectKey: string
  sessionId: string
  transcriptPath: string
  metaPath: string
  entries: TranscriptEntry[]
  trashed?: boolean
}): SessionSummary {
  const summary = summarizeTranscript(params)
  const metadata = readMetadata(params.metaPath)
  return {
    ...summary,
    metaPath: params.metaPath,
    ...(metadata ? metadataToSummaryFields(metadata) : {}),
    tags: metadata?.tags ?? [],
    ...(params.trashed ? { trashed: true } : {})
  }
}

function buildMetadata(params: {
  previous?: SessionMetadata
  summary: TranscriptSummary
  entries: TranscriptEntry[]
  cwd: string
  projectKey: string
}): SessionMetadata {
  const firstUserPrompt = params.entries.find(
    (entry): entry is Extract<TranscriptEntry, { type: 'message' }> =>
      entry.type === 'message' && entry.message.role === 'user'
  )
  const latestUsageV2 = [...params.entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: 'usage_v2' }> => entry.type === 'usage_v2')
  const model = params.previous?.model ?? latestUsageV2?.record.model
  const updatedAt =
    params.summary.updatedAt ??
    fileMtimeIso(params.summary.transcriptPath) ??
    params.previous?.updatedAt ??
    new Date().toISOString()
  const createdAt =
    params.summary.startedAt ??
    params.previous?.createdAt ??
    fileBirthIso(params.summary.transcriptPath) ??
    updatedAt

  return {
    sessionId: params.summary.sessionId,
    ...(params.previous?.displayName ? { displayName: params.previous.displayName } : {}),
    createdAt,
    updatedAt,
    messageCount: params.summary.messageCount,
    totalTokens:
      params.summary.usageTotals?.usage.totalTokens ??
      params.summary.totalUsage?.totalTokens ??
      params.previous?.totalTokens ??
      0,
    ...(firstUserPrompt
      ? { lastUserPromptDigest: truncateSingleLine(modelMessageToText(firstUserPrompt.message), 80) }
      : params.previous?.lastUserPromptDigest
        ? { lastUserPromptDigest: params.previous.lastUserPromptDigest }
        : {}),
    ...(model ? { model } : {}),
    tags: params.previous?.tags ?? [],
    cwd: params.cwd,
    projectKey: params.projectKey
  }
}

function metadataToSummaryFields(metadata: SessionMetadata): Pick<
  SessionSummary,
  'displayName' | 'updatedAt' | 'messageCount' | 'totalTokens' | 'lastUserPromptDigest' | 'model' | 'tags'
> {
  return {
    ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
    updatedAt: metadata.updatedAt,
    messageCount: metadata.messageCount,
    totalTokens: metadata.totalTokens,
    ...(metadata.lastUserPromptDigest ? { lastUserPromptDigest: metadata.lastUserPromptDigest } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    tags: metadata.tags
  }
}

function readMetadata(metaPath: string): SessionMetadata | undefined {
  if (!existsSync(metaPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf-8')) as unknown
    if (!isRecord(parsed) || typeof parsed.sessionId !== 'string') return undefined
    return {
      sessionId: parsed.sessionId,
      ...(typeof parsed.displayName === 'string' && parsed.displayName.trim()
        ? { displayName: parsed.displayName.trim() }
        : {}),
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      messageCount: typeof parsed.messageCount === 'number' ? parsed.messageCount : 0,
      totalTokens: typeof parsed.totalTokens === 'number' ? parsed.totalTokens : 0,
      ...(typeof parsed.lastUserPromptDigest === 'string'
        ? { lastUserPromptDigest: parsed.lastUserPromptDigest }
        : {}),
      ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
      ...(typeof parsed.projectKey === 'string' ? { projectKey: parsed.projectKey } : {})
    }
  } catch {
    return undefined
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function normalizeOptionalString(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readEntriesFromPath(transcriptPath: string): TranscriptEntry[] {
  if (!existsSync(transcriptPath)) return []
  const content = readFileSync(transcriptPath, 'utf-8').trim()
  if (!content) return []

  const entries: TranscriptEntry[] = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    const entry = parseEntry(line)
    if (entry) entries.push(entry)
  }
  return entries
}

function renderSessionExport(
  format: SessionExportFormat,
  summary: SessionSummary,
  entries: TranscriptEntry[],
  metadata?: SessionMetadata
): string {
  if (format === 'json') {
    return `${JSON.stringify({ meta: metadata, summary, entries }, null, 2)}\n`
  }
  if (format === 'html') return renderHtmlExport(summary, entries)
  return renderMarkdownExport(summary, entries)
}

function renderMarkdownExport(summary: SessionSummary, entries: TranscriptEntry[]): string {
  const title = summary.displayName || summary.sessionId
  const lines = [
    `# q-code 会话 - ${title}`,
    '',
    `- session: ${summary.sessionId}`,
    `- 创建: ${summary.startedAt ?? summary.updatedAt ?? '(unknown)'}`,
    `- 更新: ${summary.updatedAt ?? '(unknown)'}`,
    `- 模型: ${summary.model ?? '(unknown)'}`,
    `- 消息数: ${summary.messageCount}, tokens: ${summary.totalTokens ?? summary.totalUsage?.totalTokens ?? 0}`,
    '',
    '---',
    ''
  ]
  for (const entry of entries) {
    if (entry.type === 'message') {
      lines.push(`## ${capitalize(entry.message.role)}`, '', modelMessageToText(entry.message), '')
    } else if (entry.type === 'tool_event') {
      lines.push(
        `### 工具调用 ${entry.name}`,
        '',
        `- phase: ${entry.phase}`,
        entry.toolCallId ? `- toolCallId: ${entry.toolCallId}` : '',
        typeof entry.resultLength === 'number' ? `- resultLength: ${entry.resultLength}` : '',
        typeof entry.isError === 'boolean' ? `- isError: ${entry.isError}` : '',
        ''
      )
    }
  }
  return `${lines.filter((line) => line !== undefined).join('\n')}\n`
}

function renderHtmlExport(summary: SessionSummary, entries: TranscriptEntry[]): string {
  const title = escapeHtml(summary.displayName || summary.sessionId)
  const body = entries
    .filter((entry): entry is Extract<TranscriptEntry, { type: 'message' }> => entry.type === 'message')
    .map(
      (entry) =>
        `<section class="message ${entry.message.role}"><h2>${escapeHtml(capitalize(entry.message.role))}</h2><pre>${escapeHtml(modelMessageToText(entry.message))}</pre></section>`
    )
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>q-code 会话 - ${title}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; background: #f7f7f8; color: #1f2328; }
    header { border-bottom: 1px solid #d0d7de; margin-bottom: 1.5rem; }
    .message { background: white; border: 1px solid #d0d7de; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
    .assistant { border-left: 4px solid #0969da; }
    .user { border-left: 4px solid #1a7f37; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
  </style>
</head>
<body>
  <header>
    <h1>q-code 会话 - ${title}</h1>
    <p>session: ${escapeHtml(summary.sessionId)} · 更新: ${escapeHtml(summary.updatedAt ?? '(unknown)')} · 消息数: ${summary.messageCount}</p>
  </header>
  ${body}
</body>
</html>
`
}

function resolveExportPath(params: {
  requestedPath?: string
  cwd: string
  exportsDir: string
  sessionId: string
  displayName?: string
  format: SessionExportFormat
}): string {
  const extension = params.format === 'md' ? '.md' : `.${params.format}`
  if (params.requestedPath) {
    const resolved = resolve(params.cwd, params.requestedPath)
    return extname(resolved) ? resolved : join(resolved, defaultExportName(params.sessionId, params.displayName, extension))
  }
  return join(params.exportsDir, defaultExportName(params.sessionId, params.displayName, extension))
}

function defaultExportName(sessionId: string, displayName: string | undefined, extension: string): string {
  const name = displayName ? sanitizeFileName(displayName) : sessionId
  return `${name}-${sessionId.slice(0, 8)}${extension}`
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'session'
}

function moveIfExists(from: string, to: string): void {
  if (!existsSync(from)) return
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
}

function rmIfExists(path: string): void {
  rmSync(path, { force: true })
}

function fileMtimeIso(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return undefined
  }
}

function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

function fileBirthIso(path: string): string | undefined {
  try {
    return statSync(path).birthtime.toISOString()
  } catch {
    return undefined
  }
}

function modelMessageToText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return stableStringify(message.content)
}

function truncateSingleLine(value: string, maxLength: number): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > maxLength ? `${single.slice(0, maxLength - 1)}…` : single
}

function makeSnippet(value: string, index: number, length: number): string {
  const start = Math.max(0, index - 50)
  const end = Math.min(value.length, index + length + 50)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < value.length ? '...' : ''
  return `${prefix}${value.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function parseEntry(line: string): TranscriptEntry | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>

    // 最早的 transcript 可能直接把 ModelMessage 作为一行写入。
    if (isModelMessage(parsed)) {
      return {
        type: 'message',
        timestamp: new Date().toISOString(),
        message: parsed
      }
    }

    if (parsed.type === 'message' && isModelMessage(parsed.message)) {
      return {
        type: 'message',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        message: parsed.message
      }
    }

    if (parsed.type === 'session_meta' && typeof parsed.sessionId === 'string') {
      return {
        type: 'session_meta',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        sessionId: parsed.sessionId,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
        projectKey: typeof parsed.projectKey === 'string' ? parsed.projectKey : '',
        schemaVersion: 2
      }
    }

    if (parsed.type === 'usage' && isTokenUsage(parsed.turn) && isTokenUsage(parsed.total)) {
      return {
        type: 'usage',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        turn: parsed.turn,
        total: parsed.total
      }
    }

    if (parsed.type === 'usage_v2' && isUsageRecord(parsed.record)) {
      return {
        type: 'usage_v2',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        record: parsed.record,
        ...(isUsageTotals(parsed.totals) ? { totals: parsed.totals } : {})
      }
    }

    if (parsed.type === 'cache_mode' && isCacheMode(parsed.mode)) {
      return {
        type: 'cache_mode',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        mode: parsed.mode
      }
    }

    if (parsed.type === 'tool_event' && typeof parsed.name === 'string') {
      return {
        type: 'tool_event',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        phase: parsed.phase === 'done' ? 'done' : 'start',
        name: parsed.name,
        toolCallId: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : undefined,
        resultLength: typeof parsed.resultLength === 'number' ? parsed.resultLength : undefined,
        isError: typeof parsed.isError === 'boolean' ? parsed.isError : undefined
      }
    }

    if (parsed.type === 'compaction') {
      return {
        type: 'compaction',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
        trigger: parseCompactionTrigger(parsed.trigger),
        beforeTokens: typeof parsed.beforeTokens === 'number' ? parsed.beforeTokens : 0,
        afterTokens: typeof parsed.afterTokens === 'number' ? parsed.afterTokens : 0,
        messageCount: typeof parsed.messageCount === 'number' ? parsed.messageCount : 0
      }
    }
  } catch {
    return null
  }

  return null
}

function parseCompactionTrigger(value: unknown): CompactionTrigger {
  if (value === 'startup' || value === 'preflight' || value === 'post-turn' || value === 'manual') {
    return value
  }
  return 'manual'
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (!isRecord(value)) return false
  return (
    (value.role === 'system' ||
      value.role === 'user' ||
      value.role === 'assistant' ||
      value.role === 'tool') &&
    'content' in value
  )
}

function isTokenUsage(value: unknown): value is TokenUsage {
  return (
    isRecord(value) &&
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.totalTokens === 'number'
  )
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.timestamp === 'string' &&
    typeof value.model === 'string' &&
    isNormalizedUsage(value.usage) &&
    isCacheMode(value.cacheMode) &&
    (value.cost === undefined || isUsageCost(value.cost)) &&
    (value.pricingModel === undefined || typeof value.pricingModel === 'string')
  )
}

function isUsageTotals(value: unknown): value is UsageTotals {
  if (!isRecord(value)) return false
  return (
    typeof value.steps === 'number' &&
    isNormalizedUsage(value.usage) &&
    isCacheMode(value.cacheMode) &&
    (value.cost === undefined || isUsageCost(value.cost)) &&
    typeof value.unknownCostSteps === 'number' &&
    typeof value.cacheHitRate === 'number'
  )
}

function isNormalizedUsage(value: unknown): value is NormalizedUsage {
  return (
    isRecord(value) &&
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.cacheReadTokens === 'number' &&
    typeof value.cacheWriteTokens === 'number' &&
    typeof value.totalTokens === 'number'
  )
}

function isUsageCost(value: unknown): value is UsageCost {
  return (
    isRecord(value) &&
    typeof value.cost === 'number' &&
    typeof value.baselineCost === 'number' &&
    typeof value.savedCost === 'number'
  )
}

function isCacheMode(value: unknown): value is CacheMode {
  return value === 'auto' || value === 'on' || value === 'off'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
