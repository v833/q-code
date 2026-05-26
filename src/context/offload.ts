/**
 * 超大工具结果卸载到磁盘：替换为带预览的标记文本，并可选注入卸载索引 manifest。
 */
import type { ModelMessage } from 'ai'
import { createHash } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getProjectStorageInfo } from './project-paths'

/** 单条工具结果已卸载时的正文前缀。 */
export const OFFLOAD_MARKER = '[tool result offloaded]'
/** 多条卸载条目的索引 manifest 前缀。 */
export const OFFLOAD_INDEX_MARKER = '[context offload index]'

const DEFAULT_MIN_OFFLOAD_CHARS = 12_000
const PREVIEW_HEAD_CHARS = 600
const PREVIEW_TAIL_CHARS = 400

/** 卸载运行配置。 */
export interface ContextOffloadOptions {
  cwd: string
  sessionId: string
  /** 超过该字符数的工具输出才卸载，默认 12000 */
  minChars?: number
  storageDir?: string
}

/** 一条已卸载工具结果的磁盘元数据。 */
export interface ContextOffloadEntry {
  filePath: string
  originalChars: number
  toolName?: string
  toolCallId?: string
}

/** 卸载批处理结果。 */
export interface ContextOffloadResult {
  messages: ModelMessage[]
  offloaded: number
  entries: ContextOffloadEntry[]
  warnings: string[]
}

interface OffloadRunContext {
  offloadDir: string
  minChars: number
  sequence: number
  warnings: string[]
}

interface TransformResult<T> {
  value: T
  changed: boolean
  entries: ContextOffloadEntry[]
}

interface ToolResultMeta {
  toolName?: string
  toolCallId?: string
  source: string
}

/**
 * 扫描 tool 消息中的 tool-result，将超大输出原子写入 `<projectDir>/offloads/<session>/`。
 */
export async function offloadLargeToolResults(
  messages: ModelMessage[],
  options: ContextOffloadOptions
): Promise<ContextOffloadResult> {
  const storage = getProjectStorageInfo(options.cwd, options.storageDir)
  const offloadDir = join(storage.projectDir, 'offloads', sanitizePathSegment(options.sessionId))
  const context: OffloadRunContext = {
    offloadDir,
    minChars: options.minChars ?? DEFAULT_MIN_OFFLOAD_CHARS,
    sequence: 0,
    warnings: []
  }

  let changed = false
  const entries: ContextOffloadEntry[] = []
  const nextMessages: ModelMessage[] = []

  for (const message of messages) {
    const result = await transformMessage(message, context)
    nextMessages.push(result.value)
    changed ||= result.changed
    entries.push(...result.entries)
  }

  return {
    messages: changed ? nextMessages : messages,
    offloaded: entries.length,
    entries,
    warnings: context.warnings
  }
}

/** 判断字符串是否为卸载标记正文（含 original_chars、file、restore 行）。 */
export function isOffloadMarkerText(text: string): boolean {
  return (
    text.startsWith(`${OFFLOAD_MARKER}\n`) &&
    /\noriginal_chars: \d+/.test(text) &&
    /\nfile: \S+/.test(text) &&
    /\nrestore: /.test(text)
  )
}

/** 根据卸载条目生成索引 manifest 文本。 */
export function buildOffloadManifest(entries: ContextOffloadEntry[]): string {
  const lines = [
    OFFLOAD_INDEX_MARKER,
    '以下工具结果已无损卸载到磁盘；需要完整内容时，用 read_file 读取对应 file。',
    ...entries.map((entry, index) => {
      const bits = [
        `${index + 1}. file: ${entry.filePath}`,
        `original_chars: ${entry.originalChars}`,
        `tool: ${entry.toolName ?? 'unknown'}`,
        entry.toolCallId ? `tool_call_id: ${entry.toolCallId}` : null
      ].filter((bit): bit is string => bit !== null)
      return bits.join(' | ')
    })
  ]

  return lines.join('\n')
}

/**
 * 将 manifest 作为 user 消息注入：优先插在压缩摘要之后，否则插在末尾 user 之前或追加。
 */
export function injectOffloadManifest(
  messages: ModelMessage[],
  entries: ContextOffloadEntry[]
): { messages: ModelMessage[]; injected: boolean } {
  if (entries.length === 0) return { messages, injected: false }

  const manifestMessage: ModelMessage = {
    role: 'user',
    content: buildOffloadManifest(entries)
  }

  const summaryIndex = messages.findIndex((message) => {
    return typeof message.content === 'string' && message.content.startsWith('[以下是之前对话的压缩摘要]')
  })
  if (summaryIndex >= 0) {
    return {
      messages: [
        ...messages.slice(0, summaryIndex + 1),
        manifestMessage,
        ...messages.slice(summaryIndex + 1)
      ],
      injected: true
    }
  }

  const last = messages.at(-1)
  if (last?.role === 'user') {
    return {
      messages: [...messages.slice(0, -1), manifestMessage, last],
      injected: true
    }
  }

  return { messages: [...messages, manifestMessage], injected: true }
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96)
  return sanitized || 'session'
}

async function transformMessage(
  message: ModelMessage,
  context: OffloadRunContext
): Promise<TransformResult<ModelMessage>> {
  if (message.role !== 'tool') return unchanged(message)

  const content = message.content
  if (!Array.isArray(content)) return unchanged(message)

  let changed = false
  const entries: ContextOffloadEntry[] = []
  const nextContent: unknown[] = []
  for (const part of content as unknown[]) {
    const result = await transformToolResultPart(part, context)
    nextContent.push(result.value)
    changed ||= result.changed
    entries.push(...result.entries)
  }

  return changed
    ? { value: { ...message, content: nextContent } as ModelMessage, changed, entries }
    : unchanged(message)
}

async function transformToolResultPart(
  part: unknown,
  context: OffloadRunContext
): Promise<TransformResult<unknown>> {
  if (!isRecord(part) || part.type !== 'tool-result') return unchanged(part)

  const meta: ToolResultMeta = {
    toolName: typeof part.toolName === 'string' ? part.toolName : undefined,
    toolCallId: typeof part.toolCallId === 'string' ? part.toolCallId : undefined,
    source: 'tool-result.output'
  }
  const result = await transformToolOutput(part.output, context, meta)
  if (!result.changed) return unchanged(part)

  return {
    value: { ...part, output: result.value },
    changed: true,
    entries: result.entries
  }
}

async function transformToolOutput(
  output: unknown,
  context: OffloadRunContext,
  meta: ToolResultMeta
): Promise<TransformResult<unknown>> {
  if (typeof output === 'string') {
    return offloadStringIfLarge(output, context, meta)
  }

  if (!isRecord(output)) return unchanged(output)

  if (typeof output.value === 'string') {
    const result = await offloadStringIfLarge(output.value, context, {
      ...meta,
      source: `${meta.source}.value`
    })
    if (result.changed) {
      return {
        value: { ...output, value: result.value },
        changed: true,
        entries: result.entries
      }
    }
  }

  if (typeof output.text === 'string') {
    const result = await offloadStringIfLarge(output.text, context, {
      ...meta,
      source: `${meta.source}.text`
    })
    if (result.changed) {
      return {
        value: { ...output, text: result.value },
        changed: true,
        entries: result.entries
      }
    }
  }

  if (typeof output.content === 'string') {
    const result = await offloadStringIfLarge(output.content, context, {
      ...meta,
      source: `${meta.source}.content`
    })
    if (result.changed) {
      return {
        value: { ...output, content: result.value },
        changed: true,
        entries: result.entries
      }
    }
  }

  const json = safeJsonStringify(output)
  if (json.length < context.minChars || containsOffloadMarker(output)) return unchanged(output)

  const result = await writeOffloadBestEffort(json, context, {
    ...meta,
    source: `${meta.source}.json`
  })
  if (!result) return unchanged(output)

  return {
    value: { type: 'text', value: result.marker },
    changed: true,
    entries: [result.entry]
  }
}

async function offloadStringIfLarge(
  text: string,
  context: OffloadRunContext,
  meta: ToolResultMeta
): Promise<TransformResult<string>> {
  if (text.length < context.minChars || isOffloadMarkerText(text)) return unchanged(text)

  const result = await writeOffloadBestEffort(text, context, meta)
  if (!result) return unchanged(text)

  return {
    value: result.marker,
    changed: true,
    entries: [result.entry]
  }
}

async function writeOffloadBestEffort(
  text: string,
  context: OffloadRunContext,
  meta: ToolResultMeta
): Promise<{ marker: string; entry: ContextOffloadEntry } | null> {
  try {
    return await writeOffload(text, context, meta)
  } catch (error) {
    const tool = meta.toolName ?? 'unknown'
    context.warnings.push(
      `failed to offload ${tool} ${meta.source} (${text.length} chars): ${formatError(error)}`
    )
    return null
  }
}

async function writeOffload(
  text: string,
  context: OffloadRunContext,
  meta: ToolResultMeta
): Promise<{ marker: string; entry: ContextOffloadEntry }> {
  await mkdir(context.offloadDir, { recursive: true })

  context.sequence++
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
  const fileName = `tool-result-${String(context.sequence).padStart(4, '0')}-${hash}.txt`
  const filePath = join(context.offloadDir, fileName)
  await writeTextAtomic(filePath, text)

  const entry: ContextOffloadEntry = {
    filePath,
    originalChars: text.length,
    ...(meta.toolName ? { toolName: meta.toolName } : {}),
    ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {})
  }

  return {
    marker: formatOffloadMarker(entry, meta, text),
    entry
  }
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  let shouldCleanupTmp = true
  const handle = await open(tmpPath, 'w')
  try {
    try {
      await handle.writeFile(text, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmpPath, filePath)
    shouldCleanupTmp = false
  } finally {
    if (shouldCleanupTmp) await unlink(tmpPath).catch(() => undefined)
  }
}

function formatOffloadMarker(
  entry: ContextOffloadEntry,
  meta: ToolResultMeta,
  original: string
): string {
  const lines = [
    OFFLOAD_MARKER,
    `tool: ${entry.toolName ?? 'unknown'}`,
    entry.toolCallId ? `tool_call_id: ${entry.toolCallId}` : null,
    `source: ${meta.source}`,
    `original_chars: ${entry.originalChars}`,
    `file: ${entry.filePath}`,
    'restore: 如需完整原始工具结果，使用 read_file 读取上面的 file 路径。',
    '',
    'preview:',
    buildPreview(original)
  ].filter((line): line is string => line !== null)

  return lines.join('\n')
}

function buildPreview(text: string): string {
  const head = text.slice(0, PREVIEW_HEAD_CHARS)
  const tail = text.slice(-PREVIEW_TAIL_CHARS)
  if (head.length + tail.length >= text.length) return text
  return `${head}\n\n... [offloaded ${text.length - head.length - tail.length} chars] ...\n\n${tail}`
}

function containsOffloadMarker(value: unknown): boolean {
  if (typeof value === 'string') return isOffloadMarkerText(value)
  if (Array.isArray(value)) return value.some(containsOffloadMarker)
  if (!isRecord(value)) return false
  return Object.values(value).some(containsOffloadMarker)
}

function unchanged<T>(value: T): TransformResult<T> {
  return { value, changed: false, entries: [] }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? '', null, 2)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
