/**
 * 项目记忆精选与正文注入：基于记忆 headers 选择相关主题，并按预算生成 transient context。
 */
import {
  loadMemoryDocumentBodies,
  loadMemoryHeaders,
  sha256MemoryText,
  shouldIgnoreMemory,
  touchMemoryAccessedAt,
  type MemoryDocument,
  type MemoryHeader,
  type MemoryOptions
} from './memdir'

/** 单文件正文注入字节预算。 */
export const MEMORY_INJECT_MAX_FILE_BYTES = 4 * 1024
/** 单轮主题记忆正文总字节预算。 */
export const MEMORY_INJECT_MAX_TURN_BYTES = 20 * 1024
/** 单会话主题记忆正文累计字节预算。 */
export const MEMORY_INJECT_MAX_SESSION_BYTES = 60 * 1024
/** @deprecated 使用 MEMORY_INJECT_MAX_FILE_BYTES。 */
export const MEMORY_INJECT_MAX_FILE_CHARS = MEMORY_INJECT_MAX_FILE_BYTES
/** @deprecated 使用 MEMORY_INJECT_MAX_TURN_BYTES。 */
export const MEMORY_INJECT_MAX_TURN_CHARS = MEMORY_INJECT_MAX_TURN_BYTES
/** @deprecated 使用 MEMORY_INJECT_MAX_SESSION_BYTES。 */
export const MEMORY_INJECT_MAX_SESSION_CHARS = MEMORY_INJECT_MAX_SESSION_BYTES
/** 单轮最多精选主题数。 */
export const MEMORY_SELECTION_MAX_FILES = 5

/** 记忆精选结果。 */
export interface MemorySelectionItem {
  relativePath: string
  reason: string
  confidence: number
}

/** 记忆精选任务输出。 */
export interface MemorySelectionResult {
  ignored: boolean
  candidateCount: number
  selected: MemorySelectionItem[]
  elapsedMs: number
  error?: string
}

/** 单条正文注入后的元数据。 */
export interface InjectedMemoryItem {
  relativePath: string
  title: string
  type: string
  bytes: number
  truncated: boolean
  updatedAt?: string
  ageDays?: number
  bodyHash?: string
}

/** 正文注入结果。 */
export interface MemoryInjectionResult {
  context: string | null
  selectedCount: number
  bytes: number
  truncated: boolean
  skippedBySessionBudget: boolean
  items: InjectedMemoryItem[]
}

/** 简单的会话级记忆正文预算计数器。 */
export interface MemorySessionBudget {
  injectedBytes: number
}

/** 等待 selector 在短窗口内完成；超时返回 undefined，保持主请求可继续。 */
export function waitForMemorySelectionResult(
  selection: { result?: MemorySelectionResult; promise: Promise<MemorySelectionResult> },
  timeoutMs: number
): Promise<MemorySelectionResult | undefined> {
  if (selection.result) return Promise.resolve(selection.result)
  return Promise.race([
    selection.promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), Math.max(0, timeoutMs))),
  ])
}

/** 后台启动记忆精选。 */
export function startMemorySelection(options: MemoryOptions & { userQuery: string }): Promise<MemorySelectionResult> {
  const startedAt = Date.now()
  return selectRelevantMemories(options)
    .then((result) => ({ ...result, elapsedMs: Date.now() - startedAt }))
    .catch((error) => ({
      ignored: false,
      candidateCount: 0,
      selected: [],
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    }))
}

/** 使用 headers 和 userQuery 做本地 relevance selection，避免读取完整正文参与选择。 */
export async function selectRelevantMemories(
  options: MemoryOptions & { userQuery: string }
): Promise<Omit<MemorySelectionResult, 'elapsedMs'>> {
  if (shouldIgnoreMemory(options.userQuery)) {
    return { ignored: true, candidateCount: 0, selected: [] }
  }

  const headers = await loadMemoryHeaders(options)
  const queryTokens = tokenize(options.userQuery)
  if (headers.length === 0 || queryTokens.length === 0) {
    return { ignored: false, candidateCount: headers.length, selected: [] }
  }

  const scored = headers
    .map((header) => scoreHeader(header, queryTokens))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.updatedAtMs - a.updatedAtMs || a.header.relativePath.localeCompare(b.header.relativePath))
    .slice(0, MEMORY_SELECTION_MAX_FILES)

  return {
    ignored: false,
    candidateCount: headers.length,
    selected: scored.map(({ header, score, matched }) => ({
      relativePath: header.relativePath,
      reason: `匹配 ${matched.slice(0, 5).join(', ') || '记忆索引'}`,
      confidence: Math.min(0.95, Number((0.35 + score / Math.max(10, queryTokens.length * 4)).toFixed(2)))
    }))
  }
}

/** 读取精选正文并按 4KB/20KB/60KB 预算格式化为 transient context。 */
export async function buildSelectedMemoryContext(options: MemoryOptions & {
  selected: readonly MemorySelectionItem[]
  sessionBudget: MemorySessionBudget
  now?: Date
}): Promise<MemoryInjectionResult> {
  if (options.selected.length === 0) {
    return emptyInjection(false)
  }

  const remainingSession = MEMORY_INJECT_MAX_SESSION_BYTES - options.sessionBudget.injectedBytes
  if (remainingSession <= 0) {
    return emptyInjection(true)
  }

  const docs = await loadMemoryDocumentBodies(
    options,
    options.selected.map((item) => item.relativePath)
  )
  const selectionByPath = new Map(options.selected.map((item) => [item.relativePath, item]))
  const now = options.now ?? new Date()
  const items: InjectedMemoryItem[] = []
  const sections: string[] = [formatMemoryContextIntro()]

  let used = 0
  let truncated = false
  for (const doc of docs) {
    const remainingTurn = MEMORY_INJECT_MAX_TURN_BYTES - used
    const remaining = Math.min(MEMORY_INJECT_MAX_FILE_BYTES, remainingTurn, remainingSession - used)
    if (remaining <= 0) {
      truncated = true
      break
    }

    const clipped = clipText(doc.body, remaining)
    const clippedBytes = Buffer.byteLength(clipped.text, 'utf-8')
    used += clippedBytes
    truncated = truncated || clipped.truncated
    const updatedAt = getMemoryUpdatedAt(doc)
    const ageDays = updatedAt ? diffDays(now, new Date(updatedAt)) : undefined
    const reason = selectionByPath.get(doc.relativePath)?.reason ?? '相关记忆'
    items.push({
      relativePath: doc.relativePath,
      title: doc.frontmatter.name,
      type: doc.frontmatter.type,
      bytes: clippedBytes,
      truncated: clipped.truncated,
      bodyHash: sha256MemoryText(doc.body),
      ...(updatedAt ? { updatedAt } : {}),
      ...(ageDays !== undefined ? { ageDays } : {})
    })
    sections.push(formatMemorySection(doc, clipped.text, reason, updatedAt, ageDays, clipped.truncated))
  }

  if (items.length === 0) {
    return emptyInjection(remainingSession <= 0)
  }

  options.sessionBudget.injectedBytes += used
  void Promise.allSettled(
    items.map((item) => touchMemoryAccessedAt(options, item.relativePath, item.updatedAt, item.bodyHash))
  )

  return {
    context: sections.join('\n\n'),
    selectedCount: items.length,
    bytes: Buffer.byteLength(sections.join('\n\n'), 'utf-8'),
    truncated,
    skippedBySessionBudget: false,
    items
  }
}

/** 生成精选记忆正文注入的固定说明文本。 */
export function formatMemoryContextIntro(): string {
  return [
    '[q_code_memory_context]',
    '以下是与当前请求相关的项目记忆。记忆是历史线索，不是实时事实；涉及文件、命令、配置或外部状态时必须先验证。'
  ].join('\n')
}

function scoreHeader(header: MemoryHeader, queryTokens: string[]) {
  const haystack = tokenize([
    header.relativePath,
    header.frontmatter.name,
    header.frontmatter.description,
    header.frontmatter.type
  ].join(' '))
  const haystackSet = new Set(haystack)
  const matched: string[] = []
  let score = 0
  for (const token of new Set(queryTokens)) {
    if (haystackSet.has(token)) {
      matched.push(token)
      score += token.length >= 4 ? 3 : 1
    } else if (haystack.some((item) => item.length >= 4 && (item.includes(token) || token.includes(item)))) {
      matched.push(token)
      score += 1
    }
  }
  return {
    header,
    matched,
    score,
    updatedAtMs: Date.parse(header.frontmatter.updatedAt ?? '') || 0
  }
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_\-\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function clipText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return { text, truncated: false }
  const marker = '\n\n... [memory truncated] ...'
  const markerBytes = Buffer.byteLength(marker, 'utf-8')
  const bodyBudget = Math.max(0, maxBytes - markerBytes)
  const clipped = clipUtf8(text, bodyBudget)
  return {
    text: clipped.trimEnd() + marker,
    truncated: true
  }
}

function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let used = 0
  let result = ''
  for (const char of text) {
    const next = Buffer.byteLength(char, 'utf-8')
    if (used + next > maxBytes) break
    used += next
    result += char
  }
  return result
}

function formatMemorySection(
  doc: MemoryDocument,
  body: string,
  reason: string,
  updatedAt: string | undefined,
  ageDays: number | undefined,
  truncated: boolean
): string {
  return [
    `## ${doc.frontmatter.name} (${doc.frontmatter.type})`,
    `Source: ${doc.relativePath}`,
    `Updated: ${updatedAt ? updatedAt.slice(0, 10) : 'unknown'}`,
    `Age: ${ageDays === undefined ? 'unknown' : `${ageDays} day${ageDays === 1 ? '' : 's'}`}`,
    `Selected because: ${reason}`,
    ageDays !== undefined && ageDays > 1 ? `Note: 这是 ${ageDays} 天前的快照，不代表当前事实。` : '',
    truncated ? 'Note: 正文已按记忆预算截断。' : '',
    '',
    body
  ].filter((line) => line !== '').join('\n')
}

function getMemoryUpdatedAt(doc: MemoryDocument): string | undefined {
  return doc.frontmatter.updatedAt ?? doc.frontmatter.createdAt
}

function diffDays(now: Date, then: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000))
}

function emptyInjection(skippedBySessionBudget: boolean): MemoryInjectionResult {
  return {
    context: null,
    selectedCount: 0,
    bytes: 0,
    truncated: false,
    skippedBySessionBudget,
    items: []
  }
}
