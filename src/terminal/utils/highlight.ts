import { createRequire } from 'node:module'
import type { HighlightOptions, Theme } from 'cli-highlight'

export type HighlightThemeMode = 'dark' | 'light' | 'auto'

export const MAX_HIGHLIGHT_CODE_BYTES = 16 * 1024
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

export interface HighlightCodeOptions {
  theme?: HighlightThemeMode
  noColor?: boolean
}

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

export function resolveHighlightThemeMode(rawTheme: string | undefined = process.env.Q_CODE_THEME): HighlightThemeMode {
  const normalized = rawTheme?.trim().toLowerCase()
  if (normalized === 'dark' || normalized === 'light' || normalized === 'auto') {
    return normalized
  }
  return 'auto'
}

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

export function resolveHighlightTheme(optionsTheme?: HighlightThemeMode): HighlightThemeMode {
  const explicit = optionsTheme ?? resolveHighlightThemeMode()
  if (explicit !== 'auto') return explicit
  return resolveAutoHighlightThemeMode()
}

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
