/**
 * Output Styles：加载内置/用户级/项目级回答风格，并维护 settings 中的默认风格。
 */
import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { writeJsonAtomic } from '../utils/atomic-write'

export type OutputStyleSource = 'built-in' | 'user' | 'project'

export interface OutputStyleConfig {
  name: string
  description: string
  prompt: string
  keepCodingInstructions: boolean
  source: OutputStyleSource
}

export interface OutputStyleLoadResult {
  styles: OutputStyleConfig[]
  activeName: string
  warnings: string[]
  userSettingsPath: string
  projectSettingsPath: string
}

interface RawSettings {
  outputStyle?: unknown
}

interface RawStyleFrontmatter {
  name?: unknown
  description?: unknown
  keepCodingInstructions?: unknown
}

export const DEFAULT_OUTPUT_STYLE_NAME = 'default'

export const BUILT_IN_OUTPUT_STYLES: OutputStyleConfig[] = [
  {
    name: 'default',
    description: 'Default - concise and professional',
    prompt: '',
    keepCodingInstructions: true,
    source: 'built-in'
  },
  {
    name: 'Explanatory',
    description: 'Explain implementation choices with short Insight blocks',
    prompt: [
      '回答或改代码时，在关键设计选择前后加入简短的 Insight 小节。',
      'Insight 只解释会影响维护性、边界条件、测试或安全性的取舍；不要把每一步操作都讲成教程。',
      '保持结论清楚，避免长篇铺垫。'
    ].join('\n'),
    keepCodingInstructions: true,
    source: 'built-in'
  },
  {
    name: 'Learning',
    description: 'Guide practice and leave TODO(human) points when appropriate',
    prompt: [
      '把回答组织成适合学习者跟做的节奏。',
      '当任务适合练习时，可以留下清晰标注的 TODO(human)，并说明完成目标和检查方法。',
      '不要为了练习牺牲安全修复、数据保护或用户明确要求的完整交付。'
    ].join('\n'),
    keepCodingInstructions: true,
    source: 'built-in'
  }
]

/** 返回用户级与项目级 Output Styles / settings 路径。 */
export function getOutputStylePaths(cwd: string = process.cwd()): {
  userStylesDir: string
  projectStylesDir: string
  userSettingsPath: string
  projectSettingsPath: string
} {
  const qCodeHome = process.env.Q_CODE_HOME?.trim()
    ? resolve(process.env.Q_CODE_HOME)
    : join(homedir(), '.q-code')
  const projectRoot = resolve(cwd)
  return {
    userStylesDir: join(qCodeHome, 'output-styles'),
    projectStylesDir: join(projectRoot, '.q-code', 'output-styles'),
    userSettingsPath: join(qCodeHome, 'settings.json'),
    projectSettingsPath: join(projectRoot, '.q-code', 'settings.json')
  }
}

/** 加载内置、自定义风格和 active setting。项目级同名覆盖用户级/内置。 */
export async function loadOutputStyles(cwd: string = process.cwd()): Promise<OutputStyleLoadResult> {
  const paths = getOutputStylePaths(cwd)
  const warnings: string[] = []
  const stylesByKey = new Map<string, OutputStyleConfig>()
  for (const style of BUILT_IN_OUTPUT_STYLES) stylesByKey.set(normalizeStyleName(style.name), style)

  for (const style of await loadStyleDir(paths.userStylesDir, 'user', warnings)) {
    stylesByKey.set(normalizeStyleName(style.name), style)
  }
  for (const style of await loadStyleDir(paths.projectStylesDir, 'project', warnings)) {
    stylesByKey.set(normalizeStyleName(style.name), style)
  }

  const settings = await readMergedOutputStyleSettings(paths.userSettingsPath, paths.projectSettingsPath, warnings)
  const configured = typeof settings.outputStyle === 'string' ? settings.outputStyle.trim() : ''
  const activeName = configured && stylesByKey.has(normalizeStyleName(configured))
    ? stylesByKey.get(normalizeStyleName(configured))!.name
    : DEFAULT_OUTPUT_STYLE_NAME
  if (configured && activeName === DEFAULT_OUTPUT_STYLE_NAME && normalizeStyleName(configured) !== DEFAULT_OUTPUT_STYLE_NAME) {
    warnings.push(`settings.outputStyle "${configured}" 不存在，已回退 default`)
  }

  return {
    styles: [...stylesByKey.values()],
    activeName,
    warnings,
    userSettingsPath: paths.userSettingsPath,
    projectSettingsPath: paths.projectSettingsPath
  }
}

/** 渲染本轮动态上下文中的 Output Style 指令。 */
export function formatOutputStylePrompt(style: OutputStyleConfig | undefined): string | null {
  if (!style || normalizeStyleName(style.name) === DEFAULT_OUTPUT_STYLE_NAME || !style.prompt.trim()) {
    return null
  }
  const codingLine = style.keepCodingInstructions
    ? '保留 q-code 默认编码、安全、工具、权限、隐私和不可泄密等硬约束。'
    : '可调整普通编码表达偏好，但必须保留安全、工具、权限、隐私和不可泄密等硬约束。'
  return [`Active output style: ${style.name}`, codingLine, '', style.prompt.trim()].join('\n')
}

/** 将 active output style 写入 settings；项目风格固定写项目级，否则有项目 settings 时沿用项目级。 */
export async function persistOutputStyle(
  cwd: string,
  styleName: string,
  source?: OutputStyleSource
): Promise<string> {
  const { userSettingsPath, projectSettingsPath } = getOutputStylePaths(cwd)
  const target = source === 'project' || await pathExists(projectSettingsPath)
    ? projectSettingsPath
    : userSettingsPath
  const existing = await readJsonObject(target)
  existing.outputStyle = styleName
  await mkdir(dirname(target), { recursive: true })
  await writeJsonAtomic(target, existing)
  return target
}

export function findOutputStyle(styles: OutputStyleConfig[], name: string): OutputStyleConfig | undefined {
  const key = normalizeStyleName(name)
  return styles.find((style) => normalizeStyleName(style.name) === key)
}

export function normalizeStyleName(name: string): string {
  return name.trim().toLowerCase()
}

async function loadStyleDir(
  dir: string,
  source: OutputStyleSource,
  warnings: string[]
): Promise<OutputStyleConfig[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (isNotFoundError(error)) return []
    warnings.push(`${dir}: 读取失败: ${formatError(error)}`)
    return []
  }

  const styles: OutputStyleConfig[] = []
  for (const entry of entries.sort()) {
    if (entry.startsWith('.') || !entry.endsWith('.md')) continue
    const filePath = join(dir, entry)
    try {
      const content = await readFile(filePath, 'utf-8')
      const parsed = parseMarkdownWithFrontmatter(content)
      const fm = parsed.frontmatter as RawStyleFrontmatter
      const prompt = parsed.body.trim()
      if (!prompt) {
        warnings.push(`${filePath}: output style 缺少正文 prompt`)
        continue
      }
      styles.push({
        name: typeof fm.name === 'string' && fm.name.trim()
          ? fm.name.trim()
          : basename(entry, '.md'),
        description: typeof fm.description === 'string' && fm.description.trim()
          ? fm.description.trim()
          : '(no description)',
        prompt,
        keepCodingInstructions:
          typeof fm.keepCodingInstructions === 'boolean' ? fm.keepCodingInstructions : true,
        source
      })
    } catch (error) {
      warnings.push(`${filePath}: 解析失败: ${formatError(error)}`)
    }
  }
  return styles
}

async function readMergedOutputStyleSettings(
  userSettingsPath: string,
  projectSettingsPath: string,
  warnings: string[]
): Promise<RawSettings> {
  const user = await readJsonSettings(userSettingsPath, warnings)
  const project = await readJsonSettings(projectSettingsPath, warnings)
  return { ...user, ...project }
}

async function readJsonSettings(filePath: string, warnings: string[]): Promise<RawSettings> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf-8')) as unknown
    return isRecord(raw) ? raw : {}
  } catch (error) {
    if (isNotFoundError(error)) return {}
    warnings.push(`${filePath}: settings 读取失败: ${formatError(error)}`)
    return {}
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf-8')) as unknown
    return isRecord(raw) ? raw : {}
  } catch (error) {
    if (isNotFoundError(error)) return {}
    throw error
  }
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
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
