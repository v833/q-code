/**
 * 从用户级与项目级目录加载自定义 SubAgent（Markdown + YAML frontmatter）。
 *
 * 每个 `.md` 文件需包含 `name`、`description` 字段，正文作为
 * `getSystemPrompt()` 返回值。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { splitFrontmatter } from '../skills/parse-frontmatter'
import type { AgentDefinition, AgentIsolation, AgentSource } from './types'

/** 解析 `Q_CODE_HOME`，缺省为 `~/.q-code`。 */
export function getQCodeHome(): string {
  return process.env.Q_CODE_HOME?.trim() || path.join(os.homedir(), '.q-code')
}

/** 用户级自定义 Agent 目录：`~/.q-code/agents`。 */
export function getUserAgentsDir(): string {
  return path.join(getQCodeHome(), 'agents')
}

/** 项目级自定义 Agent 目录：`<cwd>/.q-code/agents`。 */
export function getProjectAgentsDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.q-code', 'agents')
}

interface LoadedFromDir {
  agents: AgentDefinition[]
  warnings: string[]
}

/** `loadAllCustomAgents` 的返回值。 */
export interface LoadAllCustomAgentsResult {
  agents: AgentDefinition[]
  warnings: string[]
}

/**
 * 扫描单个目录下所有 `.md` 文件并解析为 `AgentDefinition`。
 * 目录不存在（ENOENT）时静默返回空列表。
 */
async function loadFromOneDir(dir: string, source: AgentSource): Promise<LoadedFromDir> {
  let entries: string[]
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    entries = dirents
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') return { agents: [], warnings: [] }
    return { agents: [], warnings: [`[agents] Failed to read ${dir}: ${formatError(error)}`] }
  }

  const agents: AgentDefinition[] = []
  const warnings: string[] = []

  for (const fileName of entries) {
    const filePath = path.join(dir, fileName)
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      warnings.push(`[agents] Skipping ${filePath}: ${formatError(error)}`)
      continue
    }

    const split = splitFrontmatter(raw)
    if (split.parseError) {
      warnings.push(`[agents] Skipping ${fileName}: invalid frontmatter (${split.parseError})`)
      continue
    }

    const name = asString(split.raw.name)
    const description = asString(split.raw.description ?? split.raw.when_to_use ?? split.raw.whenToUse)
    const systemPrompt = split.body.trim()

    if (!name) {
      warnings.push(`[agents] Skipping ${fileName}: missing required 'name' field`)
      continue
    }
    if (!description) {
      warnings.push(`[agents] Skipping ${fileName}: missing required 'description' field`)
      continue
    }
    if (!systemPrompt) {
      warnings.push(`[agents] Skipping ${fileName}: body must contain the sub-agent system prompt`)
      continue
    }

    const tools = asStringArray(split.raw.tools)
    const disallowedTools = asStringArray(
      split.raw.disallowedTools ?? split.raw.disallowed_tools
    )
    const model = asString(split.raw.model)
    const maxTurns = asPositiveInt(split.raw.maxTurns ?? split.raw.max_turns)
    const readOnlyOnly = asBoolean(split.raw.readOnlyOnly ?? split.raw.read_only_only)
    const isolation = asIsolation(split.raw.isolation)
    const realFile = await fs.realpath(filePath).catch(() => filePath)

    agents.push({
      agentType: name,
      whenToUse: description,
      ...(tools.length > 0 ? { tools } : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      ...(readOnlyOnly ? { readOnlyOnly } : {}),
      ...(model ? { model } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(isolation ? { isolation } : {}),
      source,
      filePath: realFile,
      getSystemPrompt: () => systemPrompt
    })
  }

  return { agents, warnings }
}

/** 将 frontmatter 中的 `isolation` 规范为 `none` | `worktree`。 */
function asIsolation(value: unknown): AgentIsolation | undefined {
  const normalized = asString(value)
  if (normalized === 'none' || normalized === 'worktree') return normalized
  return undefined
}

/**
 * 并行加载用户级与项目级 Agent 目录。
 * 返回顺序为 `[...user, ...project]`；同名类型由 `bootstrapAgents` 中后项覆盖。
 */
export async function loadAllCustomAgents(cwd: string): Promise<LoadAllCustomAgentsResult> {
  const [userResult, projectResult] = await Promise.all([
    loadFromOneDir(getUserAgentsDir(), 'user'),
    loadFromOneDir(getProjectAgentsDir(cwd), 'project')
  ])

  return {
    agents: [...userResult.agents, ...projectResult.agents],
    warnings: [...userResult.warnings, ...projectResult.warnings]
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** 支持 YAML 数组或逗号分隔字符串。 */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : undefined))
      .filter((item): item is string => Boolean(item))
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function asPositiveInt(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === 'yes' || normalized === '1'
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
