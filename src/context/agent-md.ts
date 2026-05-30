/**
 * 加载 AGENT.md / AGENTS.md：从用户 home、cwd 向上链到项目根，合并为 system prompt 片段。
 */
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const AGENT_MD_NAMES = ['AGENT.md', 'AGENTS.md']
const DEFAULT_HOME_DIR = '.q-code'
export const DEFAULT_FULL_AGENT_MD_CHAR_LIMIT = 16000
export const DEFAULT_AGENT_MD_SECTION_CHAR_LIMIT = 1800
const TRUNCATED_SECTION_NOTICE = '[本节已截断；完整内容请读取对应 AGENT.md / AGENTS.md 文件。]'
const IMPORTANT_HEADING_KEYWORDS = [
  '项目概览',
  '环境与工具',
  '常用命令',
  'cli 子命令',
  '目录边界',
  '实现约定',
  '测试策略',
  'git 与提交注意',
  'repository guidelines',
  'security',
  'testing',
  'test strategy',
  'development',
  'environment',
  'tools',
  'commands',
  'architecture',
  'implementation',
  'conventions',
  'git',
  'commit'
]

/** 单个已加载的 AGENT/AGENTS 文件片段。 */
export interface AgentMdSection {
  filePath: string
  content: string
}

/** 加载选项：cwd、home 与项目根边界。 */
export interface AgentMdLoadOptions {
  cwd?: string
  homeDir?: string
  projectRoot?: string
  fullCharLimit?: number
  sectionCharLimit?: number
}

/**
 * 按约定路径顺序加载所有存在的 AGENT/AGENTS 文件。
 * @returns 非空内容的片段列表（过滤缺失文件）
 */
export async function loadAgentMdSections(
  options: AgentMdLoadOptions = {}
): Promise<AgentMdSection[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const homeDir = path.resolve(options.homeDir ?? getDefaultHomeDir())
  const projectRoot = resolveProjectRoot(cwd, options.projectRoot)
  const files = getAgentMdFiles(cwd, homeDir, projectRoot)
  const loaded = await Promise.all(
    files.map(async (filePath) => {
      const content = await readAgentMdIfExists(filePath)
      return content ? { filePath, content } : null
    })
  )

  return loaded.filter((entry): entry is AgentMdSection => entry !== null)
}

function getDefaultHomeDir(): string {
  return process.env.Q_CODE_HOME?.trim() || path.join(os.homedir(), DEFAULT_HOME_DIR)
}

/** 加载并格式化为带 `# Source:` 头的连续文本。 */
export async function loadAgentMdContext(
  options: AgentMdLoadOptions = {}
): Promise<string> {
  const sections = await loadAgentMdSections(options)
  return formatAgentMdSections(sections, options)
}

/** 将多个片段用 `# Source: <path>` 分隔拼接。 */
export function formatAgentMdSections(
  sections: readonly AgentMdSection[],
  options: Pick<AgentMdLoadOptions, 'fullCharLimit' | 'sectionCharLimit'> = {}
): string {
  return sections
    .map((section) => {
      return `# Source: ${section.filePath}\n${formatAgentMdContent(section.content, options)}`
    })
    .join('\n\n')
}

/** 在保持稳定性的前提下压缩超长 AGENT/AGENTS 内容，降低 system prompt 噪音。 */
export function formatAgentMdContent(
  content: string,
  options: Pick<AgentMdLoadOptions, 'fullCharLimit' | 'sectionCharLimit'> = {}
): string {
  const fullCharLimit = options.fullCharLimit ?? readPositiveIntEnv(
    'Q_CODE_AGENT_MD_FULL_CHAR_LIMIT',
    DEFAULT_FULL_AGENT_MD_CHAR_LIMIT
  )
  if (content.length <= fullCharLimit) return content

  const sectionCharLimit = options.sectionCharLimit ?? readPositiveIntEnv(
    'Q_CODE_AGENT_MD_SECTION_CHAR_LIMIT',
    DEFAULT_AGENT_MD_SECTION_CHAR_LIMIT
  )
  const secondarySectionCharLimit = getSecondarySectionCharLimit(sectionCharLimit)
  const sections = splitMarkdownSections(content)
  const formatted = sections.map((section) => {
    const limit = isImportantSection(section) ? sectionCharLimit : secondarySectionCharLimit
    return truncateSection(section.text, limit)
  })

  return [
    '<agent-md-summary>',
    `原始项目指令 ${content.length} chars，已为稳定 system prompt 保留所有章节；关键章节保留较长内容，其他章节保留标题与摘录。`,
    '如需完整内容请读取上方 Source 路径中的 AGENT.md / AGENTS.md，优先使用 read_file。',
    '</agent-md-summary>',
    '',
    ...formatted
  ].join('\n')
}

/**
 * 返回待尝试加载的文件路径列表（去重）：home → cwd 向上至 projectRoot。
 */
export function getAgentMdFiles(cwd: string, homeDir: string, projectRoot = resolveProjectRoot(cwd)): string[] {
  const files: string[] = []

  for (const fileName of AGENT_MD_NAMES) {
    files.push(path.join(homeDir, fileName))
  }
  for (const dir of getDirectoryChain(cwd, projectRoot)) {
    for (const fileName of AGENT_MD_NAMES) {
      files.push(path.join(dir, fileName))
    }
  }

  return [...new Set(files)]
}

function getDirectoryChain(cwd: string, projectRoot: string): string[] {
  const chain: string[] = []
  let current = path.resolve(cwd)
  const stopAt = isAncestorOrSame(projectRoot, current) ? path.resolve(projectRoot) : current

  while (true) {
    chain.push(current)
    if (samePath(current, stopAt)) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return chain.reverse()
}

function resolveProjectRoot(cwd: string, explicitProjectRoot?: string): string {
  const explicit = explicitProjectRoot ?? process.env.Q_CODE_PROJECT_ROOT?.trim()
  if (explicit) {
    const resolved = path.resolve(explicit)
    return isAncestorOrSame(resolved, cwd) ? resolved : path.resolve(cwd)
  }

  return findNearestProjectRoot(cwd) ?? path.resolve(cwd)
}

function findNearestProjectRoot(cwd: string): string | null {
  let current = path.resolve(cwd)

  while (true) {
    if (hasProjectMarker(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function hasProjectMarker(dir: string): boolean {
  return ['.git', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'].some((name) => {
    try {
      return existsSync(path.join(dir, name))
    } catch {
      return false
    }
  })
}

function isAncestorOrSame(parent: string, child: string): boolean {
  const relative = path.relative(normalizeForCompare(parent), normalizeForCompare(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function samePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right)
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function readAgentMdIfExists(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return null

    const raw = await fs.readFile(filePath, 'utf-8')
    const content = stripHtmlComments(raw).trim()
    return content || null
  } catch {
    return null
  }
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '').trim()
}

interface MarkdownSection {
  heading: string | null
  text: string
}

function splitMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = []
  const lines = content.split('\n')
  let currentHeading: string | null = null
  let currentLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, text: currentLines.join('\n').trim() })
      }
      currentHeading = line.trim()
      currentLines = [line]
      continue
    }
    currentLines.push(line)
  }

  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, text: currentLines.join('\n').trim() })
  }

  return sections.filter((section) => section.text.length > 0)
}

function isImportantSection(section: MarkdownSection): boolean {
  if (section.heading === null) return true
  const heading = section.heading.replace(/^#+\s*/u, '').trim().toLowerCase()
  return IMPORTANT_HEADING_KEYWORDS.some((keyword) => heading.includes(keyword))
}

function getSecondarySectionCharLimit(sectionCharLimit: number): number {
  return Math.min(sectionCharLimit, Math.max(80, Math.floor(sectionCharLimit / 3)))
}

function truncateSection(text: string, limit: number): string {
  if (text.length <= limit) return text
  const lines = text.split('\n')
  const heading = lines[0]?.startsWith('## ') ? lines[0] : undefined
  const budget = Math.max(0, limit - TRUNCATED_SECTION_NOTICE.length - 2)
  if (heading && heading.length < budget) {
    const bodyBudget = Math.max(0, budget - heading.length - 1)
    const body = lines.slice(1).join('\n').slice(0, bodyBudget).trimEnd()
    return [heading, body, '', TRUNCATED_SECTION_NOTICE].filter((line) => line !== undefined).join('\n')
  }

  const trimmed = text.slice(0, budget).trimEnd()
  return `${trimmed}\n\n${TRUNCATED_SECTION_NOTICE}`
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
