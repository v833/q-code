/**
 * TUI 代码块语法高亮：基于 `cli-highlight`，支持主题、`NO_COLOR`、超大块降级与 diff 着色。
 */
import { createRequire } from 'node:module'
import type { HighlightOptions, Theme } from 'cli-highlight'
import { applyAnsiTextStyle, rgb, type AnsiTextStyle, type RgbColor } from './ansi-style'

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

const DARK_PALETTE = {
  nearWhite: rgb(222, 226, 232),
  slate: rgb(148, 163, 184),
  cyan: rgb(103, 232, 249),
  sky: rgb(125, 211, 252),
  blue: rgb(147, 197, 253),
  magenta: rgb(216, 180, 254),
  amber: rgb(251, 191, 36),
  green: rgb(134, 239, 172),
  red: rgb(252, 165, 165)
} as const

const LIGHT_PALETTE = {
  nearBlack: rgb(30, 41, 59),
  slate: rgb(71, 85, 105),
  cyan: rgb(8, 145, 178),
  blue: rgb(29, 78, 216),
  magenta: rgb(147, 51, 234),
  amber: rgb(180, 83, 9),
  green: rgb(21, 128, 61),
  red: rgb(185, 28, 28)
} as const

const DARK_THEME = createTheme({
  keyword: [DARK_PALETTE.magenta, 'bold'],
  built_in: [DARK_PALETTE.sky],
  type: [DARK_PALETTE.blue],
  literal: [DARK_PALETTE.amber],
  number: [DARK_PALETTE.amber],
  regexp: [DARK_PALETTE.red],
  string: [DARK_PALETTE.green],
  subst: [DARK_PALETTE.sky],
  symbol: [DARK_PALETTE.amber],
  class: [DARK_PALETTE.blue, 'bold'],
  function: [DARK_PALETTE.cyan],
  title: [DARK_PALETTE.cyan],
  params: [DARK_PALETTE.slate],
  comment: [DARK_PALETTE.slate],
  doctag: [DARK_PALETTE.slate],
  meta: [DARK_PALETTE.slate],
  'meta-keyword': [DARK_PALETTE.magenta],
  'meta-string': [DARK_PALETTE.green],
  section: [DARK_PALETTE.cyan, 'bold'],
  tag: [DARK_PALETTE.blue],
  name: [DARK_PALETTE.cyan],
  'builtin-name': [DARK_PALETTE.cyan],
  attr: [DARK_PALETTE.amber],
  attribute: [DARK_PALETTE.amber],
  variable: [DARK_PALETTE.nearWhite],
  bullet: [DARK_PALETTE.cyan],
  code: [DARK_PALETTE.green],
  emphasis: [DARK_PALETTE.blue, 'italic'],
  strong: [DARK_PALETTE.cyan, 'bold'],
  formula: [DARK_PALETTE.magenta],
  link: [DARK_PALETTE.cyan, 'underline'],
  quote: [DARK_PALETTE.slate],
  'selector-tag': [DARK_PALETTE.cyan],
  'selector-id': [DARK_PALETTE.magenta],
  'selector-class': [DARK_PALETTE.blue],
  'selector-attr': [DARK_PALETTE.amber],
  'selector-pseudo': [DARK_PALETTE.amber],
  'template-tag': [DARK_PALETTE.cyan],
  'template-variable': [DARK_PALETTE.amber],
  addition: [DARK_PALETTE.green],
  deletion: [DARK_PALETTE.red],
  default: [DARK_PALETTE.nearWhite]
})

const LIGHT_THEME = createTheme({
  keyword: [LIGHT_PALETTE.blue, 'bold'],
  built_in: [LIGHT_PALETTE.magenta],
  type: [LIGHT_PALETTE.cyan],
  literal: [LIGHT_PALETTE.red],
  number: [LIGHT_PALETTE.magenta],
  regexp: [LIGHT_PALETTE.red],
  string: [LIGHT_PALETTE.green],
  subst: [LIGHT_PALETTE.blue],
  symbol: [LIGHT_PALETTE.magenta],
  class: [LIGHT_PALETTE.blue, 'bold'],
  function: [LIGHT_PALETTE.blue],
  title: [LIGHT_PALETTE.blue],
  params: [LIGHT_PALETTE.slate],
  comment: [LIGHT_PALETTE.slate],
  doctag: [LIGHT_PALETTE.slate],
  meta: [LIGHT_PALETTE.slate],
  'meta-keyword': [LIGHT_PALETTE.blue],
  'meta-string': [LIGHT_PALETTE.green],
  section: [LIGHT_PALETTE.blue, 'bold'],
  tag: [LIGHT_PALETTE.blue],
  name: [LIGHT_PALETTE.blue],
  'builtin-name': [LIGHT_PALETTE.blue],
  attr: [LIGHT_PALETTE.red],
  attribute: [LIGHT_PALETTE.red],
  variable: [LIGHT_PALETTE.nearBlack],
  bullet: [LIGHT_PALETTE.blue],
  code: [LIGHT_PALETTE.green],
  emphasis: [LIGHT_PALETTE.blue, 'italic'],
  strong: [LIGHT_PALETTE.blue, 'bold'],
  formula: [LIGHT_PALETTE.magenta],
  link: [LIGHT_PALETTE.blue, 'underline'],
  quote: [LIGHT_PALETTE.slate],
  'selector-tag': [LIGHT_PALETTE.blue],
  'selector-id': [LIGHT_PALETTE.magenta],
  'selector-class': [LIGHT_PALETTE.cyan],
  'selector-attr': [LIGHT_PALETTE.red],
  'selector-pseudo': [LIGHT_PALETTE.red],
  'template-tag': [LIGHT_PALETTE.blue],
  'template-variable': [LIGHT_PALETTE.magenta],
  addition: [LIGHT_PALETTE.green],
  deletion: [LIGHT_PALETTE.red],
  default: [LIGHT_PALETTE.nearBlack]
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
    return colorize(code, resolveFallbackPalette(options.theme).green)
  }

  if (shouldRenderAsDiff(code, language)) {
    return renderDiffCode(code, options.theme)
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
    return colorize(code, resolveFallbackPalette(options.theme).green)
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

function renderDiffCode(code: string, theme?: HighlightThemeMode): string {
  const palette = resolveDiffPalette(theme)
  return code
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line
      if (line.startsWith('\\ No newline at end of file')) return colorize(line, palette.muted)
      if (line.startsWith('@@')) return colorize(line, palette.hunk)
      if (DIFF_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) {
        return colorize(line, palette.muted)
      }
      if (line.startsWith('+')) return colorize(line, palette.addition)
      if (line.startsWith('-')) return colorize(line, palette.deletion)
      return line
    })
    .join('\n')
}

function resolveTheme(mode: HighlightThemeMode | undefined): Theme {
  const requested = mode ?? resolveHighlightThemeMode()
  const selected = requested === 'auto' ? resolveAutoHighlightThemeMode() : requested
  return selected === 'light' ? LIGHT_THEME : DARK_THEME
}

function colorize(text: string, color: RgbColor, extra: BasicAnsiStyle[] = []): string {
  return applyAnsiStyles(text, extra.length > 0 ? [...extra, color] : [color])
}

function createTheme(palette: Partial<Record<ThemeToken, readonly HighlightStyle[]>>): Theme {
  const theme: Partial<Theme> = {}

  for (const [token, styles] of Object.entries(palette) as Array<[ThemeToken, readonly HighlightStyle[]]>) {
    theme[token] = makeFormatter(styles)
  }

  return theme as Theme
}

function makeFormatter(styles: readonly HighlightStyle[]): (text: string) => string {
  return (text: string) => applyAnsiStyles(text, styles)
}

function applyAnsiStyles(text: string, styles: readonly HighlightStyle[]): string {
  if (styles.length === 0) return text
  const ansiStyle: AnsiTextStyle = {}
  for (const style of styles) {
    if (typeof style === 'string') {
      ansiStyle[style] = true
    } else {
      ansiStyle.color = style
    }
  }
  return applyAnsiTextStyle(text, ansiStyle)
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

type BasicAnsiStyle = 'bold' | 'italic' | 'underline'
type HighlightStyle = RgbColor | BasicAnsiStyle

function resolveFallbackPalette(theme?: HighlightThemeMode): typeof DARK_PALETTE | typeof LIGHT_PALETTE {
  return resolveHighlightTheme(theme) === 'light' ? LIGHT_PALETTE : DARK_PALETTE
}

function resolveDiffPalette(theme?: HighlightThemeMode): {
  muted: RgbColor
  hunk: RgbColor
  addition: RgbColor
  deletion: RgbColor
} {
  const mode = resolveHighlightTheme(theme)
  return mode === 'light'
    ? {
        muted: LIGHT_PALETTE.slate,
        hunk: LIGHT_PALETTE.blue,
        addition: LIGHT_PALETTE.green,
        deletion: LIGHT_PALETTE.red
      }
    : {
        muted: DARK_PALETTE.slate,
        hunk: DARK_PALETTE.cyan,
        addition: DARK_PALETTE.green,
        deletion: DARK_PALETTE.red
      }
}
