/**
 * 加载 AGENT.md / AGENTS.md：从用户 home、cwd 向上链到项目根，合并为 system prompt 片段。
 */
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const AGENT_MD_NAMES = ['AGENT.md', 'AGENTS.md']
const DEFAULT_HOME_DIR = '.q-code'

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
  return formatAgentMdSections(sections)
}

/** 将多个片段用 `# Source: <path>` 分隔拼接。 */
export function formatAgentMdSections(sections: readonly AgentMdSection[]): string {
  return sections
    .map((section) => {
      return `# Source: ${section.filePath}\n${section.content}`
    })
    .join('\n\n')
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
