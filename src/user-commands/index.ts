/**
 * User Commands：从 Markdown 模板加载用户/项目级 Slash 命令并展开为普通用户 prompt。
 */
import { type Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

export type UserCommandSource = 'user' | 'project'

export interface UserCommandConfig {
  name: string
  description: string
  argumentHint?: string
  model?: string
  allowedTools?: string[]
  prompt: string
  source: UserCommandSource
  filePath: string
  warnings: string[]
}

export interface UserCommandLoadResult {
  commands: UserCommandConfig[]
  warnings: string[]
  userCommandsDir: string
  projectCommandsDir: string
}

export interface ExpandedUserCommand {
  command: UserCommandConfig
  prompt: string
  args: string[]
}

interface RawCommandFrontmatter {
  description?: unknown
  'argument-hint'?: unknown
  argumentHint?: unknown
  model?: unknown
  'allowed-tools'?: unknown
  allowedTools?: unknown
}

const SAFE_COMMAND_NAME_RE = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/
const PLACEHOLDER_RE = /\$ARGUMENTS(?:\[(\d+)])?|\$(\d+)/g
const KNOWN_FIELDS = new Set([
  'description',
  'argument-hint',
  'argumentHint',
  'model',
  'allowed-tools',
  'allowedTools'
])

/** 返回用户级和项目级 commands 目录。 */
export function getUserCommandPaths(cwd: string = process.cwd()): {
  userCommandsDir: string
  projectCommandsDir: string
} {
  const qCodeHome = process.env.Q_CODE_HOME?.trim()
    ? resolve(process.env.Q_CODE_HOME)
    : join(homedir(), '.q-code')
  return {
    userCommandsDir: join(qCodeHome, 'commands'),
    projectCommandsDir: join(resolve(cwd), '.q-code', 'commands')
  }
}

/** 加载用户命令；项目级同名覆盖用户级，内置冲突由调用方传入后过滤。 */
export async function loadUserCommands(
  cwd: string = process.cwd(),
  builtInNames: Iterable<string> = []
): Promise<UserCommandLoadResult> {
  const paths = getUserCommandPaths(cwd)
  const warnings: string[] = []
  const reservedNames = new Set([...builtInNames].map(normalizeCommandName))
  const commandsByName = new Map<string, UserCommandConfig>()

  for (const command of await loadCommandDir(paths.userCommandsDir, 'user', warnings)) {
    addCommand(commandsByName, command, reservedNames, warnings)
  }
  for (const command of await loadCommandDir(paths.projectCommandsDir, 'project', warnings)) {
    addCommand(commandsByName, command, reservedNames, warnings)
  }

  return {
    commands: [...commandsByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
    userCommandsDir: paths.userCommandsDir,
    projectCommandsDir: paths.projectCommandsDir
  }
}

/** 展开 Markdown 命令模板为普通用户 prompt。 */
export function expandUserCommand(command: UserCommandConfig, rawArgs: string): ExpandedUserCommand {
  const args = tokenizeCommandArgs(rawArgs)
  const allArgs = rawArgs.trim()
  let usedPlaceholder = false
  let prompt = command.prompt.replace(PLACEHOLDER_RE, (_match, bracketIndex: string | undefined, positionalIndex: string | undefined) => {
    usedPlaceholder = true
    if (bracketIndex !== undefined) return args[Number(bracketIndex)] ?? ''
    if (positionalIndex !== undefined) return args[Number(positionalIndex) - 1] ?? ''
    return allArgs
  })

  if (!usedPlaceholder && allArgs) {
    prompt = `${prompt.trimEnd()}\n\nARGUMENTS: ${allArgs}`
  }

  return { command, prompt, args }
}

/** shell 风格轻量 tokenizer：支持单双引号和反斜杠转义。 */
export function tokenizeCommandArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of input.trim()) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (/\s/.test(char) && quote === null) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (escaping) current += '\\'
  if (current) args.push(current)
  return args
}

export function normalizeCommandName(name: string): string {
  return name.replace(/^\//, '').trim().toLowerCase()
}

async function loadCommandDir(
  rootDir: string,
  source: UserCommandSource,
  warnings: string[]
): Promise<UserCommandConfig[]> {
  const files = await collectMarkdownFiles(rootDir, rootDir, warnings)
  const commands: UserCommandConfig[] = []

  for (const filePath of files) {
    const commandName = commandNameFromPath(rootDir, filePath)
    if (!commandName) continue
    if (!SAFE_COMMAND_NAME_RE.test(commandName)) {
      warnings.push(`${filePath}: command name "${commandName}" 包含不安全字符`)
      continue
    }
    try {
      const content = await readFile(filePath, 'utf-8')
      const parsed = parseMarkdownWithFrontmatter(content)
      const fm = parsed.frontmatter as RawCommandFrontmatter
      const prompt = parsed.body.trim()
      if (!prompt) {
        warnings.push(`${filePath}: command 模板缺少正文 prompt`)
        continue
      }
      const commandWarnings = collectUnknownFrontmatterWarnings(parsed.frontmatter, filePath)
      const allowedTools = parseStringArray(fm['allowed-tools'] ?? fm.allowedTools, filePath, 'allowed-tools', commandWarnings)
      commands.push({
        name: commandName,
        description: typeof fm.description === 'string' && fm.description.trim()
          ? fm.description.trim()
          : '(no description)',
        ...(typeof (fm['argument-hint'] ?? fm.argumentHint) === 'string'
          ? { argumentHint: String(fm['argument-hint'] ?? fm.argumentHint).trim() }
          : {}),
        ...(typeof fm.model === 'string' && fm.model.trim() ? { model: fm.model.trim() } : {}),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        prompt,
        source,
        filePath,
        warnings: commandWarnings
      })
      warnings.push(...commandWarnings)
    } catch (error) {
      warnings.push(`${filePath}: 解析失败: ${formatError(error)}`)
    }
  }

  return commands
}

async function collectMarkdownFiles(rootDir: string, dir: string, warnings: string[]): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isNotFoundError(error)) return []
    warnings.push(`${dir}: 读取失败: ${formatError(error)}`)
    return []
  }

  const files: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const filePath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(rootDir, filePath, warnings))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(filePath)
  }
  return files
}

function commandNameFromPath(rootDir: string, filePath: string): string | null {
  const rel = relative(rootDir, filePath)
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) return null
  const withoutExt = rel.slice(0, -'.md'.length)
  return withoutExt.split(sep).map((part) => basename(part)).join(':')
}

function addCommand(
  commandsByName: Map<string, UserCommandConfig>,
  command: UserCommandConfig,
  reservedNames: Set<string>,
  warnings: string[]
): void {
  const key = normalizeCommandName(command.name)
  if (reservedNames.has(key)) {
    warnings.push(`${command.filePath}: /${command.name} 与内置 Slash 命令冲突，已忽略`)
    return
  }
  commandsByName.set(key, command)
}

function parseStringArray(
  value: unknown,
  filePath: string,
  field: string,
  warnings: string[]
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    warnings.push(`${filePath}: ${field} 必须是 string[]`)
    return []
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

function collectUnknownFrontmatterWarnings(frontmatter: Record<string, unknown>, filePath: string): string[] {
  const warnings: string[] = []
  for (const key of Object.keys(frontmatter)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`${filePath}: 未知 frontmatter 字段 "${key}" 已忽略`)
  }
  return warnings
}

function parseMarkdownWithFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith('---\n')) return { frontmatter: {}, body: content }
  const end = content.indexOf('\n---', 4)
  if (end < 0) return { frontmatter: {}, body: content }
  const rawFrontmatter = content.slice(4, end)
  const bodyStart = content.charAt(end + 4) === '\n' ? end + 5 : end + 4
  const parsed = parseYaml(rawFrontmatter) as unknown
  return { frontmatter: isRecord(parsed) ? parsed : {}, body: content.slice(bodyStart) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
