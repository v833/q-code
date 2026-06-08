/**
 * 加载 AGENT.md / AGENTS.md：从用户 home、cwd 向上链到项目根，合并为 system prompt 运行纪律片段。
 */
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const AGENT_MD_NAMES = ['AGENT.md', 'AGENTS.md']
const DEFAULT_HOME_DIR = '.q-code'
export const DEFAULT_FULL_AGENT_MD_CHAR_LIMIT = 16000
export const DEFAULT_AGENT_MD_SECTION_CHAR_LIMIT = 1800
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
const RUNTIME_HEADING_KEYWORDS = [
  '实现约定',
  '测试策略',
  'git 与提交注意',
  'security',
  'testing',
  'test strategy',
  'implementation',
  'conventions',
  'development',
  'git',
  'commit'
]
const REFERENCE_HEADING_KEYWORDS = [
  '项目概览',
  '常用命令',
  'cli 子命令',
  '目录边界',
  'environment',
  'tools',
  'commands',
  'architecture'
]
const RUNTIME_INSTRUCTION_KEYWORDS = [
  '必须',
  '不要',
  '不得',
  '禁止',
  '只能',
  '优先',
  '需要',
  '应',
  '保持',
  '避免',
  '确认',
  '验证',
  '测试',
  '运行',
  '修改',
  '权限',
  '密钥',
  '安全',
  '敏感',
  '危险',
  '拒绝',
  'prompt',
  'system prompt',
  'transient',
  'cache',
  'memory',
  '记忆',
  'tool',
  '工具',
  'skill',
  'subagent',
  'agent',
  'hooks',
  'eval',
  'output style',
  'git',
  'commit',
  'read_file',
  'grep',
  'pnpm',
  'typecheck',
  'must',
  'do not',
  'never',
  'avoid',
  'prefer',
  'test',
  'security',
  'secret',
  'permission'
]
const MAX_RUNTIME_RULE_CHARS = 280
const MAX_HEADING_INDEX_CHARS = 1600
const MAX_RULES_PER_RUNTIME_SECTION = 12
const MAX_RULES_PER_REFERENCE_SECTION = 3

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

/** 在保持稳定性的前提下压缩超长 AGENT/AGENTS 内容，只保留运行纪律摘要与文档索引。 */
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
  const sections = splitMarkdownSections(content)
  const runtimeRules = extractRuntimeInstructionLines(sections, getRuntimeRuleCharLimit(sectionCharLimit))
  const headings = formatHeadingIndex(content, MAX_HEADING_INDEX_CHARS)

  return [
    '<agent-md-runtime-summary>',
    `原始项目指令 ${content.length} chars；稳定 system prompt 只保留模型必须遵守的运行纪律摘要和文档索引。`,
    '人类可读的长文档细节不常驻注入；如需完整内容请读取上方 Source 路径中的 AGENT.md / AGENTS.md，优先使用 read_file。',
    '</agent-md-runtime-summary>',
    '',
    '## 必须遵守的运行纪律摘要',
    ...(runtimeRules.length > 0 ? runtimeRules : ['- 未提取到明确运行纪律；需要时读取完整 AGENT.md / AGENTS.md。']),
    '',
    '## 文档章节索引',
    ...(headings.length > 0 ? headings : ['- 未发现 Markdown 标题。'])
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

function getRuntimeRuleCharLimit(sectionCharLimit: number): number {
  return Math.max(600, Math.min(3600, sectionCharLimit * 2))
}

function extractRuntimeInstructionLines(sections: MarkdownSection[], maxChars: number): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  let usedChars = 0

  for (const section of orderRuntimeSections(sections)) {
    const heading = formatRuntimeHeading(section)
    let sectionRuleCount = 0
    const maxSectionRules = getMaxRulesForSection(section)
    const sectionLines = section.text.split('\n').slice(section.heading ? 1 : 0)
    for (const rawLine of sectionLines) {
      if (sectionRuleCount >= maxSectionRules) break
      const instruction = normalizeRuntimeInstructionLine(rawLine)
      if (!instruction) continue
      if (!isImportantSection(section) && !isRuntimeInstructionLine(instruction)) continue
      if (!isRuntimeInstructionLine(instruction)) continue

      const text = truncateRuntimeRule(instruction)
      const item = heading ? `- [${heading}] ${text}` : `- ${text}`
      const fingerprint = item.toLocaleLowerCase()
      if (seen.has(fingerprint)) continue

      const nextChars = usedChars + item.length + 1
      if (nextChars > maxChars) return lines
      seen.add(fingerprint)
      lines.push(item)
      sectionRuleCount++
      usedChars = nextChars
    }
  }

  return lines
}

function orderRuntimeSections(sections: MarkdownSection[]): MarkdownSection[] {
  return [...sections].sort((left, right) => {
    const priorityDelta = getSectionPriority(left) - getSectionPriority(right)
    if (priorityDelta !== 0) return priorityDelta
    return sections.indexOf(left) - sections.indexOf(right)
  })
}

function getSectionPriority(section: MarkdownSection): number {
  if (isRuntimeSection(section)) return 0
  if (isReferenceSection(section)) return 2
  return 1
}

function getMaxRulesForSection(section: MarkdownSection): number {
  return isRuntimeSection(section) ? MAX_RULES_PER_RUNTIME_SECTION : MAX_RULES_PER_REFERENCE_SECTION
}

function isRuntimeSection(section: MarkdownSection): boolean {
  return headingMatches(section, RUNTIME_HEADING_KEYWORDS)
}

function isReferenceSection(section: MarkdownSection): boolean {
  return headingMatches(section, REFERENCE_HEADING_KEYWORDS)
}

function headingMatches(section: MarkdownSection, keywords: readonly string[]): boolean {
  if (!section.heading) return false
  const heading = section.heading.replace(/^#+\s*/u, '').trim().toLowerCase()
  return keywords.some((keyword) => heading.includes(keyword))
}

function normalizeRuntimeInstructionLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (/^#{1,6}\s+/u.test(trimmed)) return null
  if (/^[-*+]\s*$/.test(trimmed)) return null
  if (/^```/.test(trimmed)) return null
  if (/^\|[-\s|:]+\|$/u.test(trimmed)) return null

  const normalized = trimmed
    .replace(/^[-*+]\s+/u, '')
    .replace(/^\d+[.)]\s+/u, '')
    .replace(/^>\s?/u, '')
    .trim()
  return normalized.length > 0 ? normalized : null
}

function isRuntimeInstructionLine(line: string): boolean {
  const normalized = line.toLocaleLowerCase()
  return RUNTIME_INSTRUCTION_KEYWORDS.some((keyword) => normalized.includes(keyword))
}

function truncateRuntimeRule(text: string): string {
  if (text.length <= MAX_RUNTIME_RULE_CHARS) return text
  return `${text.slice(0, MAX_RUNTIME_RULE_CHARS).trimEnd()}...`
}

function formatRuntimeHeading(section: MarkdownSection): string | null {
  if (!section.heading) return null
  return section.heading.replace(/^#+\s*/u, '').trim()
}

function formatHeadingIndex(content: string, maxChars: number): string[] {
  const headings = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/u.test(line))
    .map((line) => `- ${line}`)

  const result: string[] = []
  let usedChars = 0
  for (const heading of headings) {
    const nextChars = usedChars + heading.length + 1
    if (nextChars > maxChars) {
      result.push('- [章节索引已截断；完整目录请读取对应 AGENT.md / AGENTS.md 文件。]')
      break
    }
    result.push(heading)
    usedChars = nextChars
  }
  return result
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
