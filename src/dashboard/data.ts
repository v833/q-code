/**
 * 本地 Dashboard 数据采集：读取会话、审计、SubAgent artifact 与 eval artifact。
 *
 * Dashboard 默认只展示摘要、计数和哈希，不渲染 prompt、文件内容、shell 输出或工具结果原文。
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ModelMessage } from 'ai'
import { PROJECTS_DIR, getProjectStorageInfo } from '../context/project-paths'
import type { AuditRecord } from '../observability/audit'
import { getAuditConfig } from '../observability/audit'
import type { SessionSummary, TranscriptEntry } from '../session/store'
import { listAllSessionsFast } from '../session/store'
import type { CacheMode, NormalizedUsage, UsageCost, UsageRecord, UsageTotals } from '../usage'
import type { EvalTrendArtifact } from '../evals/types'

/** Dashboard 数据采集选项。 */
export interface DashboardDataOptions {
  /** 当前项目目录，默认 `process.cwd()`。 */
  cwd?: string
  /** 会话存储目录，语义与 `Q_CODE_SESSION_DIR` 一致。 */
  sessionDir?: string
  /** 审计目录，默认使用 `getAuditConfig().auditDir`。 */
  auditDir?: string
  /** 最多返回多少条最近会话。 */
  sessionLimit?: number
  /** 最多返回多少条最近审计事件。 */
  auditLimit?: number
  /** 最多返回多少条 eval run。 */
  evalLimit?: number
}

/** Dashboard 首屏快照。 */
export interface DashboardSnapshot {
  generatedAt: string
  privacy: DashboardPrivacySummary
  dataSources: DashboardDataSources
  summary: DashboardOverviewSummary
  sessions: DashboardSessionSummary[]
  audit: DashboardAuditSummary
  tasks: DashboardTaskGraphSummary
  agents: DashboardAgentArtifactSummary
  evals: DashboardEvalSummary
}

/** 隐私策略说明。 */
export interface DashboardPrivacySummary {
  localOnly: true
  redaction: 'summary-only'
  note: string
}

/** Dashboard 读取的数据源展示路径，不返回本机绝对路径。 */
export interface DashboardDataSources {
  cwd: string
  sessionRoot: string
  auditDir: string
  evalRunsDir: string
  evalTrendFile: string
  projectStorageDir: string
}

/** 首屏汇总数字。 */
export interface DashboardOverviewSummary {
  sessionCount: number
  auditEventCount: number
  taskCount: number
  agentArtifactCount: number
  evalRunCount: number
  totalTokens: number
  totalCostUsd?: number
  unknownCostSteps: number
}

/** 会话列表摘要。路径字段仅用于展示，不返回本机绝对路径。 */
export interface DashboardSessionSummary {
  sessionId: string
  displayName?: string
  cwd: string
  projectKey: string
  startedAt?: string
  updatedAt?: string
  messageCount: number
  totalTokens: number
  model?: string
  tags: string[]
  lastUserPromptDigest?: string
  transcriptPath: string
  toolCallCount: number
  usage?: DashboardUsageTotals
}

/** 单个会话详情。 */
export interface DashboardSessionDetail {
  session: DashboardSessionSummary
  messages: DashboardMessageSummary[]
  tools: DashboardToolEvent[]
  usageRecords: DashboardUsageRecord[]
  compactions: DashboardCompactionSummary[]
}

/** 消息脱敏摘要。 */
export interface DashboardMessageSummary {
  timestamp: string
  role: string
  contentChars: number
  contentSha256: string
  preview: string
}

/** 工具轨迹摘要。 */
export interface DashboardToolEvent {
  timestamp: string
  phase: 'start' | 'done'
  name: string
  toolCallId?: string
  resultLength?: number
  isError?: boolean
}

/** 单步 usage 摘要。 */
export interface DashboardUsageRecord {
  timestamp: string
  model: string
  cacheMode: CacheMode
  usage: NormalizedUsage
  cost?: UsageCost
  pricingModel?: string
}

/** usage 累计摘要。 */
export interface DashboardUsageTotals {
  steps: number
  usage: NormalizedUsage
  cacheMode: CacheMode
  cost?: UsageCost
  unknownCostSteps: number
  cacheHitRate: number
}

/** 压缩事件摘要。 */
export interface DashboardCompactionSummary {
  timestamp: string
  trigger: string
  beforeTokens: number
  afterTokens: number
  messageCount: number
}

/** 审计模块摘要。 */
export interface DashboardAuditSummary {
  totalEvents: number
  recentEvents: DashboardAuditEvent[]
  byEvent: Record<string, number>
  byTool: Record<string, number>
  bySession: Record<string, number>
}

/** 审计事件脱敏摘要。 */
export interface DashboardAuditEvent {
  ts: string
  event: string
  sessionId?: string
  agentKind?: string
  toolName?: string
  ok?: boolean
  isError?: boolean
  resultLength?: number
  payloadKeys: string[]
}

/** Task V2 静态任务图摘要。 */
export interface DashboardTaskGraphSummary {
  tasks: DashboardTaskNode[]
  edges: DashboardTaskEdge[]
  byStatus: Record<string, number>
}

/** 单个任务节点摘要。 */
export interface DashboardTaskNode {
  sessionId: string
  taskId: string
  status: string
  subjectPreview: string
  blocks: string[]
  blockedBy: string[]
}

/** 任务依赖边，`from` 阻塞 `to`。 */
export interface DashboardTaskEdge {
  sessionId: string
  from: string
  to: string
}

/** Agent artifact 摘要集合。 */
export interface DashboardAgentArtifactSummary {
  artifacts: DashboardAgentArtifact[]
  byStatus: Record<string, number>
  totalToolUseCount: number
  totalTokens: number
}

/** 单个 Agent artifact 摘要。路径字段仅用于展示，不返回本机绝对路径。 */
export interface DashboardAgentArtifact {
  sessionId: string
  agentId: string
  agentType?: string
  status: 'running' | 'completed' | 'failed' | 'unknown'
  outputPath: string
  finalArtifactPath?: string
  startedAt?: string
  updatedAt?: string
  durationMs?: number
  toolUseCount: number
  totalTokens: number
  description?: string
}

/** Eval artifact 摘要。 */
export interface DashboardEvalSummary {
  runs: DashboardEvalRun[]
  trend?: DashboardEvalTrend
  baselines: DashboardEvalRun[]
}

/** 单个 eval run 摘要。`outputDir` 仅用于展示，不返回本机绝对路径。 */
export interface DashboardEvalRun {
  runId: string
  suiteName: string
  startedAt: string
  finishedAt: string
  durationMs: number
  resultCount: number
  passed: number
  failed: number
  passRate: number
  averageScore: number
  averageProgressRate: number
  totalTokens: number
  totalEstimatedCostUsd?: number
  outputDir: string
}

/** eval trend 摘要。 */
export interface DashboardEvalTrend {
  generatedAt: string
  runCount: number
  latestPassRate?: number
  latestAverageScore?: number
  deltas?: EvalTrendArtifact['deltas']
}

type JsonObject = Record<string, unknown>

const DEFAULT_SESSION_LIMIT = 80
const DEFAULT_AUDIT_LIMIT = 200
const DEFAULT_EVAL_LIMIT = 30
const MAX_SUMMARY_JSONL_BYTES = 256 * 1024
const MAX_DETAIL_JSONL_BYTES = 1024 * 1024
const MAX_AUDIT_FILES = 14
const MAX_JSON_FILE_BYTES = 1024 * 1024
const MAX_WALK_FILES = 500
const MAX_WALK_ENTRIES = 5000

interface JsonLinesReadOptions {
  maxBytes?: number
  mode?: 'head' | 'tail'
}

/** 采集 Dashboard 首屏快照。 */
export function collectDashboardData(options: DashboardDataOptions = {}): DashboardSnapshot {
  const cwd = resolve(options.cwd ?? process.cwd())
  const dataOptions: DashboardDataOptions = {
    ...options,
    cwd
  }
  const dataSources = getDashboardDataSources(cwd, dataOptions)
  const sessions = collectSessions(dataOptions)
  const audit = collectAuditSummary(dataOptions)
  const tasks = collectTaskGraph(cwd, options.sessionDir)
  const agents = collectAgentArtifacts(cwd, options.sessionDir)
  const evals = collectEvalSummary(cwd, options.evalLimit ?? DEFAULT_EVAL_LIMIT)
  const totalUsage = summarizeUsage(sessions)

  return {
    generatedAt: new Date().toISOString(),
    privacy: {
      localOnly: true,
      redaction: 'summary-only',
      note: 'Dashboard 默认只读取本地文件，并只展示摘要、哈希、计数、token 与成本。'
    },
    dataSources,
    summary: {
      sessionCount: sessions.length,
      auditEventCount: audit.totalEvents,
      taskCount: tasks.tasks.length,
      agentArtifactCount: agents.artifacts.length,
      evalRunCount: evals.runs.length,
      totalTokens: totalUsage.totalTokens,
      ...(totalUsage.costUsd !== undefined ? { totalCostUsd: totalUsage.costUsd } : {}),
      unknownCostSteps: totalUsage.unknownCostSteps
    },
    sessions,
    audit,
    tasks,
    agents,
    evals
  }
}

/** 采集单个会话详情。 */
export function collectDashboardSessionDetail(
  sessionId: string,
  options: DashboardDataOptions = {}
): DashboardSessionDetail | undefined {
  const cwd = resolve(options.cwd ?? process.cwd())
  const session = findSessionSummary(sessionId, {
    ...options,
    cwd
  })
  if (!session) return undefined

  const entries = readTranscriptEntries(session.transcriptPath, {
    maxBytes: MAX_DETAIL_JSONL_BYTES,
    mode: 'tail'
  })
  return {
    session: summarizeDashboardSession(session, cwd),
    messages: entries
      .filter((entry): entry is Extract<TranscriptEntry, { type: 'message' }> => entry.type === 'message')
      .map((entry) => summarizeMessage(entry.timestamp, entry.message)),
    tools: entries
      .filter((entry): entry is Extract<TranscriptEntry, { type: 'tool_event' }> => entry.type === 'tool_event')
      .map((entry) => ({
        timestamp: entry.timestamp,
        phase: entry.phase,
        name: entry.name,
        ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.resultLength === 'number' ? { resultLength: entry.resultLength } : {}),
        ...(typeof entry.isError === 'boolean' ? { isError: entry.isError } : {})
      })),
    usageRecords: entries
      .filter((entry): entry is Extract<TranscriptEntry, { type: 'usage_v2' }> => entry.type === 'usage_v2')
      .map((entry) => summarizeUsageRecord(entry.record)),
    compactions: entries
      .filter((entry): entry is Extract<TranscriptEntry, { type: 'compaction' }> => entry.type === 'compaction')
      .map((entry) => ({
        timestamp: entry.timestamp,
        trigger: entry.trigger,
        beforeTokens: entry.beforeTokens,
        afterTokens: entry.afterTokens,
        messageCount: entry.messageCount
      }))
  }
}

function collectSessions(options: DashboardDataOptions): DashboardSessionSummary[] {
  const cwd = resolve(options.cwd ?? process.cwd())
  const limit = options.sessionLimit ?? DEFAULT_SESSION_LIMIT
  return listAllSessionsFast({
    cwd,
    sessionDir: options.sessionDir
  })
    .slice(0, limit)
    .map((session) => summarizeDashboardSession(session, cwd))
}

function findSessionSummary(sessionId: string, options: DashboardDataOptions): SessionSummary | undefined {
  const normalized = sessionId.trim()
  if (!normalized) return undefined
  return listAllSessionsFast({
    cwd: options.cwd,
    sessionDir: options.sessionDir
  }).find((session) => session.sessionId === normalized)
}

function summarizeDashboardSession(session: SessionSummary, cwd: string): DashboardSessionSummary {
  const entries = readTranscriptEntries(session.transcriptPath, {
    maxBytes: MAX_SUMMARY_JSONL_BYTES,
    mode: 'tail'
  })
  const usageTotals = findLatestUsageTotals(entries)
  const toolCallCount = entries.filter(
    (entry) => entry.type === 'tool_event' && entry.phase === 'start'
  ).length
  return {
    sessionId: session.sessionId,
    ...(session.displayName ? { displayName: session.displayName } : {}),
    cwd: formatDashboardPath(session.cwd, cwd),
    projectKey: session.projectKey,
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
    messageCount: session.messageCount,
    totalTokens: session.totalTokens ?? usageTotals?.usage.totalTokens ?? 0,
    ...(session.model ? { model: session.model } : {}),
    tags: session.tags,
    ...(session.lastUserPromptDigest ? { lastUserPromptDigest: redactPreview(session.lastUserPromptDigest) } : {}),
    transcriptPath: formatDashboardPath(session.transcriptPath, cwd),
    toolCallCount,
    ...(usageTotals ? { usage: usageTotals } : {})
  }
}

function collectAuditSummary(options: DashboardDataOptions): DashboardAuditSummary {
  const auditDir = options.auditDir ?? getAuditConfig().auditDir
  const records = listAuditFiles(auditDir)
    .slice(-MAX_AUDIT_FILES)
    .flatMap((filePath) =>
      readAuditRecords(filePath, {
        maxBytes: MAX_SUMMARY_JSONL_BYTES,
        mode: 'tail'
      })
    )
  const recentRecords = records.slice(-Math.max(0, options.auditLimit ?? DEFAULT_AUDIT_LIMIT)).reverse()
  const byEvent: Record<string, number> = {}
  const byTool: Record<string, number> = {}
  const bySession: Record<string, number> = {}

  for (const record of records) {
    byEvent[record.event] = (byEvent[record.event] ?? 0) + 1
    if (record.sessionId) bySession[record.sessionId] = (bySession[record.sessionId] ?? 0) + 1
    const toolName = extractToolName(record.payload)
    if (toolName) byTool[toolName] = (byTool[toolName] ?? 0) + 1
  }

  return {
    totalEvents: records.length,
    recentEvents: recentRecords.map(summarizeAuditRecord),
    byEvent,
    byTool,
    bySession
  }
}

function collectAgentArtifacts(cwd: string, sessionDir?: string): DashboardAgentArtifactSummary {
  const storage = getProjectStorageInfo(cwd, sessionDir)
  const projectsDir = join(storage.rootDir, PROJECTS_DIR)
  const outputFiles = walkFiles(projectsDir, (filePath) => filePath.endsWith('.output'))
  const finalArtifactFiles = walkFiles(projectsDir, (filePath) => filePath.endsWith('.final.md'))
  const finalByKey = new Map<string, string>()
  for (const filePath of finalArtifactFiles) {
    const parts = filePath.split(/[/\\]/)
    const agentFile = parts.at(-1) ?? ''
    const sessionId = parts.at(-2) ?? ''
    const agentId = agentFile.replace(/\.final\.md$/, '')
    finalByKey.set(`${sessionId}/${agentId}`, filePath)
  }

  const artifacts = outputFiles.map((filePath) => summarizeAgentOutput(filePath, finalByKey, cwd))
  const byStatus: Record<string, number> = {}
  for (const artifact of artifacts) {
    byStatus[artifact.status] = (byStatus[artifact.status] ?? 0) + 1
  }

  return {
    artifacts: artifacts.sort(sortByUpdatedAt).slice(0, 80),
    byStatus,
    totalToolUseCount: artifacts.reduce((sum, artifact) => sum + artifact.toolUseCount, 0),
    totalTokens: artifacts.reduce((sum, artifact) => sum + artifact.totalTokens, 0)
  }
}

function collectTaskGraph(cwd: string, sessionDir?: string): DashboardTaskGraphSummary {
  const storage = getProjectStorageInfo(cwd, sessionDir)
  const tasksRoot = join(storage.rootDir, PROJECTS_DIR)
  const taskFiles = walkFiles(tasksRoot, (filePath) => {
    return filePath.includes(`${separatorFragment()}tasks${separatorFragment()}`) && filePath.endsWith('.json')
  })
  const tasks = taskFiles
    .map(readDashboardTask)
    .filter((task): task is DashboardTaskNode => Boolean(task))
  const edges: DashboardTaskEdge[] = []
  const byStatus: Record<string, number> = {}

  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
    for (const downstream of task.blocks) {
      edges.push({
        sessionId: task.sessionId,
        from: task.taskId,
        to: downstream
      })
    }
  }

  return {
    tasks: tasks.sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.taskId.localeCompare(b.taskId)),
    edges,
    byStatus
  }
}

function readDashboardTask(filePath: string): DashboardTaskNode | undefined {
  const parsed = readJsonFile(filePath)
  if (!isObject(parsed)) return undefined
  const taskId = typeof parsed.id === 'string' ? parsed.id : undefined
  const subject = typeof parsed.subject === 'string' ? parsed.subject : ''
  const status = typeof parsed.status === 'string' ? parsed.status : undefined
  if (!taskId || !status) return undefined
  const parts = filePath.split(/[/\\]/)
  const sessionId = parts.at(-2) ?? 'unknown'
  return {
    sessionId,
    taskId,
    status,
    subjectPreview: redactPreview(subject),
    blocks: parseStringArray(parsed.blocks),
    blockedBy: parseStringArray(parsed.blockedBy)
  }
}

function separatorFragment(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function summarizeAgentOutput(filePath: string, finalByKey: Map<string, string>, cwd = process.cwd()): DashboardAgentArtifact {
  const records = readJsonLines(filePath, {
    maxBytes: MAX_SUMMARY_JSONL_BYTES,
    mode: 'tail'
  })
  const first = records[0]
  const last = records.at(-1)
  const parts = filePath.split(/[/\\]/)
  const agentFile = parts.at(-1) ?? basename(filePath)
  const sessionId = parts.at(-2) ?? 'unknown'
  const agentId = agentFile.replace(/\.output$/, '')
  let status: DashboardAgentArtifact['status'] = 'unknown'
  let durationMs: number | undefined
  let totalTokens = 0
  let completedToolUseCount: number | undefined

  if (last?.type === 'completed') {
    status = 'completed'
    durationMs = asNumber(last.durationMs)
    totalTokens = asNumber(last.totalTokens) ?? 0
    completedToolUseCount = asNumber(last.toolUseCount)
  } else if (last?.type === 'failed') {
    status = 'failed'
    durationMs = asNumber(last.durationMs)
  } else if (records.length > 0) {
    status = 'running'
  }

  if (totalTokens === 0) {
    totalTokens = records
      .filter((record) => record.type === 'turn_usage')
      .reduce((sum, record) => sum + (asNumber(record.totalTokens) ?? 0), 0)
  }

  return {
    sessionId,
    agentId,
    ...(typeof first?.agentType === 'string' ? { agentType: first.agentType } : {}),
    status,
    outputPath: formatDashboardPath(filePath, cwd),
    ...(finalByKey.get(`${sessionId}/${agentId}`)
      ? { finalArtifactPath: formatDashboardPath(finalByKey.get(`${sessionId}/${agentId}`) ?? '', cwd) }
      : {}),
    ...(typeof first?.timestamp === 'string' ? { startedAt: first.timestamp } : {}),
    ...(typeof last?.timestamp === 'string' ? { updatedAt: last.timestamp } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    toolUseCount: completedToolUseCount ?? records.filter((record) => record.type === 'tool_use').length,
    totalTokens,
    ...(typeof first?.description === 'string' ? { description: redactPreview(first.description) } : {})
  }
}

function collectEvalSummary(cwd: string, limit: number): DashboardEvalSummary {
  const runsDir = join(cwd, '.q-code', 'evals', 'runs')
  const baselinesDir = join(cwd, '.q-code', 'evals', 'baselines')
  const trendFile = join(cwd, '.q-code', 'evals', 'trends', 'trend.json')
  return {
    runs: readEvalRuns(runsDir, cwd).slice(0, limit),
    trend: readEvalTrend(trendFile),
    baselines: readEvalRuns(baselinesDir, cwd).slice(0, limit)
  }
}

function readEvalRuns(rootDir: string, cwd: string): DashboardEvalRun[] {
  return walkFiles(rootDir, (filePath) => basename(filePath) === 'run.json')
    .map((filePath) => readEvalRun(filePath, cwd))
    .filter((run): run is DashboardEvalRun => Boolean(run))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function readEvalRun(filePath: string, cwd: string): DashboardEvalRun | undefined {
  const parsed = readJsonFile(filePath)
  const summary = isObject(parsed) && isObject(parsed.summary) ? parsed.summary : parsed
  if (!isObject(summary) || typeof summary.runId !== 'string') return undefined
  const totalUsage = isObject(summary.totalUsage) ? summary.totalUsage : undefined
  return {
    runId: summary.runId,
    suiteName: typeof summary.suiteName === 'string' ? summary.suiteName : 'unknown',
    startedAt: typeof summary.startedAt === 'string' ? summary.startedAt : '',
    finishedAt: typeof summary.finishedAt === 'string' ? summary.finishedAt : '',
    durationMs: asNumber(summary.durationMs) ?? 0,
    resultCount: asNumber(summary.resultCount) ?? 0,
    passed: asNumber(summary.passed) ?? 0,
    failed: asNumber(summary.failed) ?? 0,
    passRate: asNumber(summary.passRate) ?? 0,
    averageScore: asNumber(summary.averageScore) ?? 0,
    averageProgressRate: asNumber(summary.averageProgressRate) ?? 0,
    totalTokens: asNumber(totalUsage?.totalTokens) ?? 0,
    ...(asNumber(summary.totalEstimatedCostUsd) !== undefined
      ? { totalEstimatedCostUsd: asNumber(summary.totalEstimatedCostUsd) }
      : {}),
    outputDir: formatDashboardPath(typeof summary.outputDir === 'string' ? summary.outputDir : dirname(filePath), cwd)
  }
}

function readEvalTrend(filePath: string): DashboardEvalTrend | undefined {
  const parsed = readJsonFile(filePath) as Partial<EvalTrendArtifact> | undefined
  if (!isObject(parsed) || !Array.isArray(parsed.runs)) return undefined
  const latest = parsed.runs.at(-1)
  return {
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
    runCount: parsed.runs.length,
    ...(latest ? { latestPassRate: latest.passRate, latestAverageScore: latest.averageScore } : {}),
    ...(parsed.deltas ? { deltas: parsed.deltas } : {})
  }
}

function getDashboardDataSources(cwd: string, options: DashboardDataOptions): DashboardDataSources {
  const storage = getProjectStorageInfo(cwd, options.sessionDir)
  return {
    cwd: formatDashboardPath(cwd, cwd),
    sessionRoot: formatDashboardPath(storage.rootDir, cwd),
    auditDir: formatDashboardPath(options.auditDir ?? getAuditConfig().auditDir, cwd),
    evalRunsDir: formatDashboardPath(join(cwd, '.q-code', 'evals', 'runs'), cwd),
    evalTrendFile: formatDashboardPath(join(cwd, '.q-code', 'evals', 'trends', 'trend.json'), cwd),
    projectStorageDir: formatDashboardPath(storage.projectDir, cwd)
  }
}

function summarizeUsage(sessions: DashboardSessionSummary[]): {
  totalTokens: number
  costUsd?: number
  unknownCostSteps: number
} {
  let costUsd = 0
  let hasCost = false
  let unknownCostSteps = 0
  const totalTokens = sessions.reduce((sum, session) => {
    if (session.usage?.cost) {
      hasCost = true
      costUsd += session.usage.cost.cost
    }
    unknownCostSteps += session.usage?.unknownCostSteps ?? 0
    return sum + session.totalTokens
  }, 0)
  return {
    totalTokens,
    ...(hasCost ? { costUsd } : {}),
    unknownCostSteps
  }
}

function findLatestUsageTotals(entries: TranscriptEntry[]): DashboardUsageTotals | undefined {
  const usageEntry = [...entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: 'usage_v2' }> => {
      return entry.type === 'usage_v2' && Boolean(entry.totals)
    })
  if (!usageEntry?.totals) return undefined
  return normalizeUsageTotals(usageEntry.totals)
}

function normalizeUsageTotals(totals: UsageTotals): DashboardUsageTotals {
  return {
    steps: totals.steps,
    usage: normalizeUsage(totals.usage),
    cacheMode: totals.cacheMode,
    ...(totals.cost ? { cost: totals.cost } : {}),
    unknownCostSteps: totals.unknownCostSteps,
    cacheHitRate: totals.cacheHitRate
  }
}

function summarizeUsageRecord(record: UsageRecord): DashboardUsageRecord {
  return {
    timestamp: record.timestamp,
    model: record.model,
    cacheMode: record.cacheMode,
    usage: normalizeUsage(record.usage),
    ...(record.cost ? { cost: record.cost } : {}),
    ...(record.pricingModel ? { pricingModel: record.pricingModel } : {})
  }
}

function normalizeUsage(usage: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0
  }
}

function summarizeMessage(timestamp: string, message: ModelMessage): DashboardMessageSummary {
  const text = modelMessageToText(message)
  return {
    timestamp,
    role: message.role,
    contentChars: text.length,
    contentSha256: sha256(text),
    preview: redactPreview(text)
  }
}

function summarizeAuditRecord(record: AuditRecord): DashboardAuditEvent {
  const payload = record.payload ?? {}
  const toolName = extractToolName(payload)
  const ok = typeof payload.ok === 'boolean' ? payload.ok : undefined
  const isError = typeof payload.isError === 'boolean' ? payload.isError : undefined
  const resultLength = asNumber(payload.resultLength)
  return {
    ts: record.ts,
    event: record.event,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.agent?.kind ? { agentKind: record.agent.kind } : {}),
    ...(toolName ? { toolName } : {}),
    ...(ok !== undefined ? { ok } : {}),
    ...(isError !== undefined ? { isError } : {}),
    ...(resultLength !== undefined ? { resultLength } : {}),
    payloadKeys: Object.keys(payload).sort()
  }
}

function extractToolName(payload: JsonObject): string | undefined {
  const name = payload.name ?? payload.toolName
  return typeof name === 'string' && name.trim() ? name : undefined
}

function readTranscriptEntries(transcriptPath: string, options?: JsonLinesReadOptions): TranscriptEntry[] {
  return readJsonLines(transcriptPath, options).filter(isTranscriptEntry)
}

function isTranscriptEntry(value: JsonObject): value is TranscriptEntry {
  return typeof value.type === 'string' && typeof value.timestamp === 'string'
}

function readAuditRecords(filePath: string, options?: JsonLinesReadOptions): AuditRecord[] {
  return readJsonLines(filePath, options).filter((record): record is AuditRecord & JsonObject => {
    return typeof record.ts === 'string' && typeof record.event === 'string'
  })
}

function listAuditFiles(auditDir: string): string[] {
  if (!existsSync(auditDir)) return []
  return readdirSync(auditDir)
    .filter((name) => /^audit-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.ndjson$/.test(name))
    .sort(compareAuditFileName)
    .map((name) => join(auditDir, name))
}

function compareAuditFileName(a: string, b: string): number {
  const [dateA, suffixA] = parseAuditFileName(a)
  const [dateB, suffixB] = parseAuditFileName(b)
  return dateA.localeCompare(dateB) || suffixA - suffixB
}

function parseAuditFileName(name: string): [string, number] {
  const match = name.match(/^audit-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.ndjson$/)
  return [match?.[1] ?? '', Number(match?.[2] ?? 0)]
}

function readJsonLines(filePath: string, options: JsonLinesReadOptions = {}): JsonObject[] {
  if (!existsSync(filePath)) return []
  return readTextFileBounded(filePath, options)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line)
        return isObject(parsed) ? [parsed] : []
      } catch {
        return []
      }
    })
}

function readJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) return undefined
  if (statSync(filePath).size > MAX_JSON_FILE_BYTES) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
  } catch {
    return undefined
  }
}

function walkFiles(rootDir: string, predicate: (filePath: string) => boolean): string[] {
  if (!existsSync(rootDir)) return []
  const results: string[] = []
  const stack = [rootDir]
  let seenEntries = 0
  while (stack.length > 0 && results.length < MAX_WALK_FILES && seenEntries < MAX_WALK_ENTRIES) {
    const current = stack.pop()
    if (!current) continue
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seenEntries += 1
      const filePath = join(current, entry.name)
      if (entry.isDirectory()) stack.push(filePath)
      else if (entry.isFile() && predicate(filePath)) {
        results.push(filePath)
        if (results.length >= MAX_WALK_FILES) break
      }
    }
  }
  return results
}

function readTextFileBounded(filePath: string, options: JsonLinesReadOptions): string {
  const maxBytes = Math.max(1, options.maxBytes ?? MAX_SUMMARY_JSONL_BYTES)
  const mode = options.mode ?? 'tail'
  const size = statSync(filePath).size
  if (size <= maxBytes) return readFileSync(filePath, 'utf-8')

  const bytesToRead = Math.min(size, maxBytes)
  const start = mode === 'tail' ? size - bytesToRead : 0
  const buffer = Buffer.alloc(bytesToRead)
  const fd = openSync(filePath, 'r')
  try {
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, start)
    const text = buffer.subarray(0, bytesRead).toString('utf-8')
    return mode === 'tail'
      ? text.replace(/^[^\n]*(?:\r?\n|$)/, '')
      : text.replace(/(?:\r?\n)?[^\n]*$/, '')
  } finally {
    closeSync(fd)
  }
}

function modelMessageToText(message: ModelMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!isObject(part)) return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      if (typeof record.type === 'string') return `[${record.type}]`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function redactPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return '[empty]'
  return `[redacted ${normalized.length} chars, sha256:${sha256(normalized).slice(0, 12)}]`
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function sortByUpdatedAt(a: DashboardAgentArtifact, b: DashboardAgentArtifact): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 将绝对路径转为相对 cwd 的短路径，仅用于页面展示。 */
export function formatDashboardPath(filePath: string, cwd: string): string {
  const resolvedCwd = resolve(cwd)
  const resolvedPath = resolve(filePath)
  const rel = relative(resolvedCwd, resolvedPath)
  if (!rel) return '.'
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel

  const qCodeHome = process.env.Q_CODE_HOME ? resolve(process.env.Q_CODE_HOME) : undefined
  if (qCodeHome) {
    const qCodeRel = relative(qCodeHome, resolvedPath)
    if (qCodeRel && !qCodeRel.startsWith('..') && !isAbsolute(qCodeRel)) {
      return `<Q_CODE_HOME>/${qCodeRel}`
    }
  }
  return '<external>'
}
