/**
 * TUI 代码块语法高亮：基于 `cli-highlight`，支持主题、`NO_COLOR`、超大块降级与 diff 着色。
 */
import { createRequire } from 'node:module'
import type { HighlightOptions, Theme } from 'cli-highlight'

/** 高亮主题模式；`auto` 时根据终端环境推断 dark/light。 */
export type HighlightThemeMode = 'dark' | 'light' | 'auto'

/** 超过此字节数的代码块跳过完整高亮，仅做单色 fallback。 */
export const MAX_HIGHLIGHT_CODE_BYTES = 16 * 1024

/** 传给 `cli-highlight` 的语言别名白名单。 */
export const HIGHLIGHT_LANGUAGE_SUBSET: string[] = [
  'ts',
  'tsx',
  'typescript',
  'js',
  'jsx',
  'javascript',
  'py',
  'python',
  'go',
  'golang',
  'rs',
  'rust',
  'java',
  'kotlin',
  'cs',
  'csharp',
  'cpp',
  'c++',
  'c',
  'sh',
  'bash',
  'ps1',
  'powershell',
  'json',
  'yaml',
  'yml',
  'toml',
  'sql',
  'md',
  'markdown',
  'dockerfile',
  'html',
  'xml',
  'css',
  'scss'
] as const

const require = createRequire(import.meta.url)
let cliHighlightModule: typeof import('cli-highlight') | undefined

const DARK_THEME = createTheme({
  keyword: ['magenta'],
  built_in: ['cyan'],
  type: ['blue'],
  literal: ['yellow'],
  number: ['yellow'],
  regexp: ['red'],
  string: ['green'],
  subst: ['cyan'],
  symbol: ['yellow'],
  class: ['blue'],
  function: ['cyan'],
  title: ['cyan'],
  params: ['gray'],
  comment: ['gray', 'dim'],
  doctag: ['gray', 'dim'],
  meta: ['gray'],
  'meta-keyword': ['magenta'],
  'meta-string': ['green'],
  section: ['cyan'],
  tag: ['blue'],
  name: ['cyan'],
  'builtin-name': ['cyan'],
  attr: ['yellow'],
  attribute: ['yellow'],
  variable: ['white'],
  bullet: ['cyan'],
  code: ['green'],
  emphasis: ['italic'],
  strong: ['bold'],
  formula: ['magenta'],
  link: ['cyan'],
  quote: ['gray'],
  'selector-tag': ['cyan'],
  'selector-id': ['magenta'],
  'selector-class': ['blue'],
  'selector-attr': ['yellow'],
  'selector-pseudo': ['yellow'],
  'template-tag': ['cyan'],
  'template-variable': ['yellow'],
  addition: ['green'],
  deletion: ['red'],
  default: ['white']
})

const LIGHT_THEME = createTheme({
  keyword: ['blue'],
  built_in: ['magenta'],
  type: ['cyan'],
  literal: ['red'],
  number: ['magenta'],
  regexp: ['red'],
  string: ['green'],
  subst: ['blue'],
  symbol: ['magenta'],
  class: ['blue'],
  function: ['blue'],
  title: ['blue'],
  params: ['gray'],
  comment: ['gray', 'dim'],
  doctag: ['gray', 'dim'],
  meta: ['gray'],
  'meta-keyword': ['blue'],
  'meta-string': ['green'],
  section: ['blue'],
  tag: ['blue'],
  name: ['blue'],
  'builtin-name': ['blue'],
  attr: ['red'],
  attribute: ['red'],
  variable: ['blue'],
  bullet: ['blue'],
  code: ['green'],
  emphasis: ['italic'],
  strong: ['bold'],
  formula: ['magenta'],
  link: ['blue'],
  quote: ['gray'],
  'selector-tag': ['blue'],
  'selector-id': ['magenta'],
  'selector-class': ['cyan'],
  'selector-attr': ['red'],
  'selector-pseudo': ['red'],
  'template-tag': ['blue'],
  'template-variable': ['magenta'],
  addition: ['green'],
  deletion: ['red'],
  default: ['black']
})

const DIFF_HEADER_PREFIXES = ['diff --git ', 'index ', '--- ', '+++ ']

/** {@link highlightCode} 的可选主题与无颜色覆盖。 */
export interface HighlightCodeOptions {
  /** 显式主题；省略时走 `Q_CODE_THEME` 与 auto 推断。 */
  theme?: HighlightThemeMode
  /** 为 true 时跳过着色；省略时尊重 `NO_COLOR`。 */
  noColor?: boolean
}

/**
 * 为 Markdown 代码块生成 ANSI 着色文本；失败或禁色时返回原文或单色 fallback。
 *
 * @param language - 可选语言 hint；空则靠 `languageSubset` 自动检测。
 * @returns 含 ANSI 转义序列的字符串。
 */
export function highlightCode(
  code: string,
  language: string | undefined,
  options: HighlightCodeOptions = {}
): string {
  if (code.length === 0) return code
  if (options.noColor ?? isNoColorEnabled()) return code
  if (Buffer.byteLength(code, 'utf8') > MAX_HIGHLIGHT_CODE_BYTES) {
    return colorize(code, 'green')
  }

  if (shouldRenderAsDiff(code, language)) {
    return renderDiffCode(code)
  }

  try {
    const { highlight } = loadCliHighlight()
    const highlightOptions: HighlightOptions = {
      ignoreIllegals: true,
      theme: resolveTheme(options.theme),
      ...(language?.trim()
        ? { language: language.trim(), languageSubset: HIGHLIGHT_LANGUAGE_SUBSET }
        : { languageSubset: HIGHLIGHT_LANGUAGE_SUBSET })
    }

    return highlight(code, highlightOptions)
  } catch {
    return colorize(code, 'green')
  }
}

/** 将 `Q_CODE_THEME` 等原始值规范为 {@link HighlightThemeMode}；无效值默认 `auto`。 */
export function resolveHighlightThemeMode(rawTheme: string | undefined = process.env.Q_CODE_THEME): HighlightThemeMode {
  const normalized = rawTheme?.trim().toLowerCase()
  if (normalized === 'dark' || normalized === 'light' || normalized === 'auto') {
    return normalized
  }
  return 'auto'
}

/**
 * 在 `auto` 模式下推断终端背景倾向的 dark/light 主题。
 *
 * 优先读 `COLORFGBG`，其次常见终端 `TERM_PROGRAM` 启发式，默认 `dark`。
 */
export function resolveAutoHighlightThemeMode(env = process.env): Exclude<HighlightThemeMode, 'auto'> {
  const colorFgBg = env.COLORFGBG?.trim()
  if (colorFgBg) {
    const background = parseColorFgbg(colorFgBg)
    if (background !== undefined) return background >= 7 ? 'light' : 'dark'
  }

  const termProgram = env.TERM_PROGRAM?.trim().toLowerCase()
  if (termProgram) {
    if (['apple_terminal', 'iterm.app', 'vscode', 'wezterm', 'warpterminal', 'kitty', 'ghostty', 'hyper'].some(
      (hint) => termProgram.includes(hint)
    )) {
      return 'dark'
    }
  }

  return 'dark'
}

/** 解析最终生效的高亮主题（展开 `auto` 为 dark 或 light）。 */
export function resolveHighlightTheme(optionsTheme?: HighlightThemeMode): HighlightThemeMode {
  const explicit = optionsTheme ?? resolveHighlightThemeMode()
  if (explicit !== 'auto') return explicit
  return resolveAutoHighlightThemeMode()
}

/** 是否应禁用 ANSI 着色（`NO_COLOR` 环境变量已设置，含空字符串）。 */
export function isNoColorEnabled(noColorEnv = process.env.NO_COLOR): boolean {
  return noColorEnv !== undefined && noColorEnv !== null
}

function shouldRenderAsDiff(code: string, language: string | undefined): boolean {
  const normalizedLanguage = language?.trim().toLowerCase()
  if (normalizedLanguage === 'diff' || normalizedLanguage === 'patch') return true

  const firstNonEmptyLine = code.split(/\r?\n/).find((line) => line.trim().length > 0)
  if (!firstNonEmptyLine) return false

  if (firstNonEmptyLine.startsWith('@@')) return true
  if (DIFF_HEADER_PREFIXES.some((prefix) => firstNonEmptyLine.startsWith(prefix))) return true
  if (firstNonEmptyLine.startsWith('\\ No newline at end of file')) return true
  return firstNonEmptyLine.startsWith('+') || firstNonEmptyLine.startsWith('-')
}

function renderDiffCode(code: string): string {
  return code
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line
      if (line.startsWith('\\ No newline at end of file')) return colorize(line, 'gray')
      if (line.startsWith('@@')) return colorize(line, 'cyan')
      if (DIFF_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) {
        return colorize(line, 'gray')
      }
      if (line.startsWith('+')) return colorize(line, 'green')
      if (line.startsWith('-')) return colorize(line, 'red')
      return line
    })
    .join('\n')
}

function resolveTheme(mode: HighlightThemeMode | undefined): Theme {
  const requested = mode ?? resolveHighlightThemeMode()
  const selected = requested === 'auto' ? resolveAutoHighlightThemeMode() : requested
  return selected === 'light' ? LIGHT_THEME : DARK_THEME
}

function colorize(text: string, color: AnsiColor, extra: AnsiStyle[] = []): string {
  return applyAnsiStyles(text, extra.length > 0 ? [...extra, color] : [color])
}

function createTheme(palette: Partial<Record<ThemeToken, readonly AnsiStyle[]>>): Theme {
  const theme: Partial<Theme> = {}

  for (const [token, styles] of Object.entries(palette) as Array<[ThemeToken, readonly AnsiStyle[]]>) {
    theme[token] = makeFormatter(styles)
  }

  return theme as Theme
}

function makeFormatter(styles: readonly AnsiStyle[]): (text: string) => string {
  return (text: string) => applyAnsiStyles(text, styles)
}

function applyAnsiStyles(text: string, styles: readonly AnsiStyle[]): string {
  if (styles.length === 0) return text
  const codes = styles.map((style) => ANSI_CODES[style]).join(';')
  return `\x1b[${codes}m${text}\x1b[0m`
}

function parseColorFgbg(raw: string): number | undefined {
  const matches = raw
    .split(/[;:]/)
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value))

  if (matches.length === 0) return undefined
  return matches[matches.length - 1]
}

function loadCliHighlight(): typeof import('cli-highlight') {
  if (!cliHighlightModule) {
    cliHighlightModule = require('cli-highlight') as typeof import('cli-highlight')
  }
  return cliHighlightModule
}

type ThemeToken = Exclude<keyof Theme, 'default'> | 'default'

type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'

type AnsiStyle = AnsiColor | 'bold' | 'dim' | 'italic' | 'underline' | 'inverse' | 'hidden' | 'strikethrough'

const ANSI_CODES: Record<AnsiStyle, number> = {
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
  hidden: 8,
  strikethrough: 9,
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90
}
