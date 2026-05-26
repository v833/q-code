/**
 * 项目记忆目录读写：`MEMORY.md` 索引、主题 Markdown 文件与 system prompt 记忆指引组装。
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getProjectStorageInfo } from '../project-paths'
import {
  buildMemoryAccessGuidance,
  buildMemoryExclusionGuidance,
  buildMemoryPersistenceBoundaryGuidance,
  buildMemoryTypeGuidance,
  buildMemoryValidationGuidance,
  isMemoryType,
  type MemoryEntry,
  type MemoryFrontmatter,
  type MemoryType
} from './memory-types'

/** 记忆索引文件名。 */
export const MEMORY_ENTRYPOINT = 'MEMORY.md'
/** 索引文件最大行数。 */
export const MAX_ENTRYPOINT_LINES = 200
/** 索引文件最大字节数。 */
export const MAX_ENTRYPOINT_BYTES = 25000

/** 含 frontmatter 与正文的完整记忆文档。 */
export interface MemoryDocument extends MemoryEntry {
  frontmatter: MemoryFrontmatter
  body: string
  relativePath: string
}

/** 仅含 frontmatter 与路径的记忆元数据（不含正文）。 */
export interface MemoryHeader extends MemoryEntry {
  frontmatter: MemoryFrontmatter
  relativePath: string
}

/** 记忆目录解析选项。 */
export interface MemoryOptions {
  cwd?: string
  storageDir?: string
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function sanitizeSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'memory'
  )
}

/** 返回 `<projectDir>/memory` 绝对路径。 */
export function getProjectMemoryDir(options: MemoryOptions = {}): string {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.storageDir)
  return path.join(storage.projectDir, 'memory')
}

/** 创建记忆目录并在缺失时初始化空 `MEMORY.md`。 */
export async function ensureMemoryDirExists(options: MemoryOptions = {}): Promise<string> {
  const memoryDir = getProjectMemoryDir(options)
  await fs.mkdir(memoryDir, { recursive: true })
  const entrypoint = path.join(memoryDir, MEMORY_ENTRYPOINT)
  try {
    await fs.access(entrypoint)
  } catch {
    await fs.writeFile(entrypoint, '# Project Memory\n\n', 'utf-8')
  }
  return memoryDir
}

/** 生成记忆目录与索引路径说明段落。 */
export function formatMemorySystemLocation(memoryDir: string): string[] {
  const entrypointPath = path.join(memoryDir, MEMORY_ENTRYPOINT)
  return [
    `你有一个文件级、跨对话持久化的项目记忆系统，目录为：${memoryDir}`,
    `记忆索引文件是：${entrypointPath}`,
    `索引会指向同一目录下的主题记忆文件。创建新记忆前，先检查已有主题文件，能更新就更新。`
  ]
}

/** 生成写入/更新记忆的操作指引段落。 */
export function buildMemoryPromptInstructions(): string[] {
  return [
    '只把未来对话仍然有用、且不能从当前仓库可靠推导的信息写入项目记忆。',
    '保存记忆时写一个 Markdown 文件，frontmatter 必须包含 name、description、type。',
    `写入或更新记忆后，同步更新 ${MEMORY_ENTRYPOINT}，格式为：- [Title](file.md) — one-line hook。`,
    `${MEMORY_ENTRYPOINT} 是索引，不保存完整记忆正文。`,
    `保持 ${MEMORY_ENTRYPOINT} 不超过 ${MAX_ENTRYPOINT_LINES} 行、${MAX_ENTRYPOINT_BYTES} bytes。`
  ]
}

/**
 * 组装注入 system prompt 的完整项目记忆说明（含索引内容与各类指引）。
 * 用户查询含「忽略记忆」短语时不注入索引正文。
 */
export async function buildMemorySystemContext(params: {
  cwd?: string
  storageDir?: string
  userQuery?: string
} = {}): Promise<string> {
  const ignoreMemory = params.userQuery ? shouldIgnoreMemory(params.userQuery) : false
  const memoryDir = await ensureMemoryDirExists(params)
  const entrypoint = ignoreMemory ? null : await readMemoryEntrypoint(params)
  const sections = [
    ...formatMemorySystemLocation(memoryDir),
    ...buildMemoryPromptInstructions(),
    ...buildMemoryTypeGuidance(),
    ...buildMemoryExclusionGuidance(),
    ...buildMemoryAccessGuidance(),
    ...buildMemoryValidationGuidance(),
    ...buildMemoryPersistenceBoundaryGuidance(),
    ignoreMemory ? '本轮用户要求忽略记忆：不要应用、引用或比较任何已保存项目记忆。' : '',
    entrypoint ? `Memory index:\n${entrypoint}` : ''
  ].filter(Boolean)

  return sections.join('\n\n')
}

/** 读取并截断后的 `MEMORY.md` 索引文本；空文件返回 null。 */
export async function readMemoryEntrypoint(options: MemoryOptions = {}): Promise<string | null> {
  const memoryDir = await ensureMemoryDirExists(options)
  const raw = await fs.readFile(path.join(memoryDir, MEMORY_ENTRYPOINT), 'utf-8')
  const truncated = truncateEntrypoint(raw)
  return [truncated.content, truncated.warning].filter(Boolean).join('\n\n') || null
}

/** 列出所有有效主题记忆文件（含正文）。 */
export async function listMemoryFiles(options: MemoryOptions = {}): Promise<MemoryDocument[]> {
  const headers = await loadMemoryHeaders(options)
  return loadMemoryDocumentBodies(
    options,
    headers.map((header) => header.relativePath)
  )
}

/** 加载所有主题记忆的 frontmatter 元数据（不读正文）。 */
export async function loadMemoryHeaders(options: MemoryOptions = {}): Promise<MemoryHeader[]> {
  const memoryDir = await ensureMemoryDirExists(options)
  const relativePaths = await collectMemoryMarkdownFiles(memoryDir)
  const headers = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = path.join(memoryDir, relativePath)
      const raw = await fs.readFile(filePath, 'utf-8')
      const frontmatter = parseFrontmatter(raw)
      if (!frontmatter) return null
      return {
        fileName: relativePath,
        relativePath,
        filePath,
        title: frontmatter.name,
        hook: frontmatter.description,
        frontmatter
      } satisfies MemoryHeader
    })
  )

  return headers
    .filter((header): header is MemoryHeader => header !== null)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

/**
 * 按相对路径批量加载记忆正文；路径越界或 frontmatter 无效时跳过。
 */
export async function loadMemoryDocumentBodies(
  options: MemoryOptions,
  relativePaths: readonly string[]
): Promise<MemoryDocument[]> {
  const memoryDir = await ensureMemoryDirExists(options)
  const uniquePaths = [...new Set(relativePaths)]
  const docs = await Promise.all(
    uniquePaths.map(async (relativePath) => {
      const safePath = resolveMemoryFilePath(memoryDir, relativePath)
      if (!safePath) return null
      const raw = await fs.readFile(safePath, 'utf-8')
      const frontmatter = parseFrontmatter(raw)
      if (!frontmatter) return null
      return {
        fileName: relativePath,
        relativePath,
        filePath: safePath,
        title: frontmatter.name,
        hook: frontmatter.description,
        frontmatter,
        body: stripFrontmatter(raw)
      } satisfies MemoryDocument
    })
  )

  return docs.filter((doc): doc is MemoryDocument => doc !== null)
}

/**
 * 写入或更新主题记忆文件，并重建 `MEMORY.md` 索引。
 * @returns 文件路径、文件名及是否为更新已有文件
 */
export async function writeProjectMemory(input: {
  cwd?: string
  storageDir?: string
  name: string
  description: string
  type: MemoryType
  content: string
  fileName?: string
}): Promise<{ filePath: string; fileName: string; updatedExisting: boolean }> {
  const memoryDir = await ensureMemoryDirExists(input)
  const existingFileName =
    normalizeMemoryFileName(input.fileName) ??
    (await findExistingMemoryFile(input, input.name, input.description))
  const fileName = existingFileName ?? slugifyMemoryFileName(input.name)
  const filePath = path.join(memoryDir, fileName)

  const body = [
    '---',
    `name: ${normalizeLine(input.name)}`,
    `description: ${normalizeLine(input.description)}`,
    `type: ${input.type}`,
    '---',
    '',
    input.content.trim(),
    ''
  ].join('\n')

  await fs.writeFile(filePath, body, 'utf-8')
  const docs = await listMemoryFiles(input)
  await rewriteEntrypoint(
    memoryDir,
    docs.map((doc) => ({
      fileName: doc.fileName,
      filePath: doc.filePath,
      title: doc.frontmatter.name,
      hook: doc.frontmatter.description
    }))
  )

  return { filePath, fileName, updatedExisting: Boolean(existingFileName) }
}

/** 检测用户查询是否要求本轮忽略已保存记忆。 */
export function shouldIgnoreMemory(query: string): boolean {
  const normalized = query.toLowerCase()
  return ['ignore memory', "don't use memory", 'do not use memory', '忽略记忆', '不要用记忆', '别用记忆'].some((term) =>
    normalized.includes(term)
  )
}

async function collectMemoryMarkdownFiles(memoryDir: string, currentDir = memoryDir): Promise<string[]> {
  const dirents = await fs.readdir(currentDir, { withFileTypes: true })
  const nested = await Promise.all(
    dirents.map(async (entry) => {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) return collectMemoryMarkdownFiles(memoryDir, fullPath)
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== MEMORY_ENTRYPOINT) {
        return [path.relative(memoryDir, fullPath)]
      }
      return []
    })
  )

  return nested.flat()
}

async function findExistingMemoryFile(
  options: MemoryOptions,
  name: string,
  description: string
): Promise<string | null> {
  const docs = await listMemoryFiles(options)
  const normalizedName = normalizeLine(name).toLowerCase()
  const normalizedDescription = normalizeLine(description).toLowerCase()

  const exact = docs.find((doc) => doc.frontmatter.name.toLowerCase() === normalizedName)
  if (exact) return exact.fileName

  const similar = docs.find((doc) => {
    const existing = `${doc.frontmatter.name} ${doc.frontmatter.description}`.toLowerCase()
    return existing.includes(normalizedName) || existing.includes(normalizedDescription)
  })

  return similar?.fileName ?? null
}

async function rewriteEntrypoint(memoryDir: string, entries: MemoryEntry[]): Promise<void> {
  const unique = new Map<string, string>()
  for (const entry of entries) {
    unique.set(entry.fileName, `- [${normalizeLine(entry.title)}](${entry.fileName}) — ${normalizeLine(entry.hook)}`)
  }

  const bodyLines = ['# Project Memory', '', ...[...unique.values()]]
  const truncated = truncateEntrypoint(bodyLines.join('\n'))
  const finalText = [truncated.content, truncated.warning].filter(Boolean).join('\n\n') + '\n'
  await fs.writeFile(path.join(memoryDir, MEMORY_ENTRYPOINT), finalText, 'utf-8')
}

function parseFrontmatter(raw: string): MemoryFrontmatter | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return null

  const fields = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index === -1) continue
    fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim())
  }

  const name = fields.get('name')
  const description = fields.get('description')
  const type = fields.get('type')
  if (!name || !description || !type || !isMemoryType(type)) return null
  return { name: normalizeLine(name), description: normalizeLine(description), type }
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
}

function truncateEntrypoint(raw: string): { content: string; warning?: string } {
  let content = raw
  let lineTruncated = false
  let byteTruncated = false

  const lines = content.split(/\r?\n/)
  if (lines.length > MAX_ENTRYPOINT_LINES) {
    content = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    lineTruncated = true
  }

  while (Buffer.byteLength(content, 'utf-8') > MAX_ENTRYPOINT_BYTES && content.length > 0) {
    content = content.slice(0, -1)
    byteTruncated = true
  }

  const warning =
    lineTruncated || byteTruncated
      ? `> WARNING: MEMORY.md was truncated${lineTruncated ? ' by line limit' : ''}${
          lineTruncated && byteTruncated ? ' and' : ''
        }${byteTruncated ? ' by byte limit' : ''}.`
      : undefined

  return { content: content.trim(), ...(warning ? { warning } : {}) }
}

function normalizeMemoryFileName(value: string | undefined): string | undefined {
  if (!value) return undefined
  const fileName = value.trim()
  if (!fileName || path.isAbsolute(fileName) || fileName.includes('/') || fileName.includes('\\')) {
    return undefined
  }
  const normalized = fileName.endsWith('.md') ? fileName : `${fileName}.md`
  const safeName = sanitizeSlug(normalized).replace(/\.+/g, '-').replace(/-md$/, '.md')
  if (safeName.toLowerCase() === MEMORY_ENTRYPOINT.toLowerCase()) return undefined
  return safeName
}

function slugifyMemoryFileName(name: string): string {
  const base = sanitizeSlug(name).replace(/\.+/g, '-')
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
  const safeBase = base === 'memory' ? `memory-${hash}` : base
  const fileName = `${safeBase}.md`
  return fileName.toLowerCase() === MEMORY_ENTRYPOINT.toLowerCase() ? `memory-${hash}.md` : fileName
}

function resolveMemoryFilePath(memoryDir: string, relativePath: string): string | null {
  const resolved = path.resolve(memoryDir, relativePath)
  const relative = path.relative(memoryDir, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}
