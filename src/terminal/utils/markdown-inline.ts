/**
 * Markdown 行内语义解析：保留 strong、emphasis、代码、链接、文件引用等 TUI 高亮信息。
 */
import { Lexer, type Token } from 'marked'
import { applyAnsiTextStyle, rgb, type RgbColor } from './ansi-style'
import { resolveHighlightTheme, type HighlightThemeMode } from './highlight'

/** 行内语义 segment 类型。 */
export type MarkdownInlineSegment =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string; segments: MarkdownInlineSegment[] }
  | { type: 'emphasis'; text: string; segments: MarkdownInlineSegment[] }
  | { type: 'inlineCode'; text: string }
  | { type: 'link'; text: string; href: string; segments: MarkdownInlineSegment[] }
  | { type: 'url'; text: string; href: string }
  | { type: 'fileRef'; text: string; path: string; line?: number; column?: number; label?: string }
  | { type: 'issueRef'; text: string; id: string }
  | { type: 'status'; text: string; tone: StatusTone }
  | { type: 'envVar'; text: string; name: string }
  | { type: 'command'; text: string; command: string }

/** 普通文本状态提示的语义级别。 */
export type StatusTone = 'success' | 'warning' | 'error'

const FILE_REF_PATTERN =
  /(?<![\w@.-])((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])?(?:(?:[\w.@()[\]-]+[\\/])+)?[\w.@()[\]-]+\.(?:[cm]?[jt]sx?|[cm]js|json|mdx?|ya?ml|toml|txt|html?|css|s[ac]ss|less|vue|svelte|astro|py|go|rs|java|kt|kts|cs|c|cc|cpp|cxx|h|hpp|sh|bash|zsh|fish|ps1|bat|cmd|sql|xml|dockerfile)(?::\d{1,7}){0,2})(?![\w.-])/giu
const LINE_SUFFIX_PATTERN = /^(?<path>.+?):(?<line>\d{1,7})(?::(?<column>\d{1,7}))?$/
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()\]]+[^\s<>().,\]]/giu
const ISSUE_REF_PATTERN = /(?<![\w/])#\d+\b/gu
const STATUS_PATTERN =
  /(?<![\p{L}\p{N}_-])(?:(?:ERROR|ERR|FAILED|FAILURE|FATAL|WARNING|WARN|SUCCESS|DONE|PASSED|Error|Failed|Success|Done|error|failed|success|done|错误|失败|异常|警告|成功|完成|通过)(?:[:：])?|(?:Warning|Warn|Failure|Fatal|Passed|warning|warn|failure|fatal|passed)[:：])(?![\p{L}\p{N}_-])/gu
const ENV_VAR_PATTERN =
  /(?<![\w.-])([A-Z][A-Z0-9_]{2,})(?:=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，。)]+))?(?![\w.-])/g
const COMMAND_ARG = "--?[\\w-]+(?:=[^\\s`'\"，。；;|&()<>]+)?"
const COMMAND_PATH_ARG = `(?:${COMMAND_ARG}|[\\w./\\\\:-]+)`
const COMMAND_SOURCES = [
  `(?:pnpm|npm|yarn)\\s+(?:run\\s+)?(?:test(?::[\\w-]+)?|typecheck|build|start|install|exec\\s+vitest|exec\\s+tsx|lint|format|precommit|continue|dev)(?:\\s+${COMMAND_ARG}){0,3}`,
  `npx\\s+q-code(?:\\s+${COMMAND_ARG}){0,3}`,
  `git\\s+(?:status|diff|show|log|commit|push|pull|fetch|branch|checkout|switch|add|restore|merge|rebase)(?:\\s+${COMMAND_ARG}){0,4}`,
  `(?:node|tsx)\\s+[^\\s\`'"，。；;|&()<>]+\\.(?:[cm]?[jt]sx?|mjs|cjs)(?:\\s+${COMMAND_ARG}){0,3}`,
  'tsc\\s+--noEmit',
  `vitest\\s+run(?:\\s+${COMMAND_PATH_ARG}){0,4}`,
  `q-code\\s+(?:help|version|update|audit|init|eval|continue)(?:\\s+${COMMAND_ARG}){0,3}`
]
const COMMAND_PATTERN = new RegExp(String.raw`(?<![\w@./-])(?:${COMMAND_SOURCES.join('|')})(?![\w@./-])`, 'giu')

const KNOWN_ENV_NAMES = new Set(['NO_COLOR', 'NODE_ENV', 'PATH', 'HOME', 'USERPROFILE', 'TERM_PROGRAM', 'COLORFGBG'])

/** 解析一段 Markdown 行内文本为语义 segment。 */
export function parseMarkdownInline(text: string): MarkdownInlineSegment[] {
  return parseInlineTokens(Lexer.lexInline(text, { gfm: true, breaks: false }))
}

/** 将 segment 渲染回无颜色纯文本，供 NO_COLOR、表格宽度和兼容字段使用。 */
export function renderInlineSegmentsPlain(segments: readonly MarkdownInlineSegment[]): string {
  return segments.map(renderInlineSegmentPlain).join('')
}

/** 将行内 segment 渲染为 ANSI 字符串；主要用于表格 cell 这类非 React 片段。 */
export function renderInlineSegmentsAnsi(
  segments: readonly MarkdownInlineSegment[],
  options: { noColor?: boolean; theme?: HighlightThemeMode } = {}
): string {
  if (options.noColor) return renderInlineSegmentsPlain(segments)
  const palette = resolveInlinePalette(options.theme)
  return segments.map((segment) => renderInlineSegmentAnsi(segment, palette)).join('')
}

/** 解析文件引用的展示片段，供 React 与 ANSI 渲染共用。 */
export function formatFileRefParts(segment: Extract<MarkdownInlineSegment, { type: 'fileRef' }>): {
  label?: string
  path: string
  suffix: string
} {
  const suffix = [
    segment.line !== undefined ? `:${segment.line}` : '',
    segment.column !== undefined ? `:${segment.column}` : ''
  ].join('')
  return {
    ...(segment.label ? { label: segment.label } : {}),
    path: segment.path,
    suffix
  }
}

/** 根据主题选择行内语义高亮 palette。 */
export function resolveInlinePalette(theme?: HighlightThemeMode): InlinePalette {
  return resolveHighlightTheme(theme) === 'light' ? LIGHT_INLINE_PALETTE : DARK_INLINE_PALETTE
}

function parseInlineTokens(tokens: Token[]): MarkdownInlineSegment[] {
  return mergeTextSegments(tokens.flatMap(parseInlineToken))
}

function parseInlineToken(token: Token): MarkdownInlineSegment[] {
  switch (token.type) {
    case 'text':
    case 'escape':
      return scanPlainText(token.text)
    case 'codespan':
      return [{ type: 'inlineCode', text: token.text }]
    case 'strong': {
      const segments = token.tokens ? parseInlineTokens(token.tokens) : scanPlainText(token.text)
      return [{ type: 'strong', text: renderInlineSegmentsPlain(segments), segments }]
    }
    case 'em': {
      const segments = token.tokens ? parseInlineTokens(token.tokens) : scanPlainText(token.text)
      return [{ type: 'emphasis', text: renderInlineSegmentsPlain(segments), segments }]
    }
    case 'del':
      return token.tokens ? parseInlineTokens(token.tokens) : scanPlainText(token.text)
    case 'link': {
      const segments = token.tokens ? parseInlineTokens(token.tokens) : scanPlainText(token.text)
      const label = renderInlineSegmentsPlain(segments) || token.text
      const cleanedHref = cleanFileHref(token.href)
      if (isLikelyFileRef(cleanedHref)) {
        return [createFileRefSegment(label, cleanedHref, label === cleanedHref ? undefined : label)]
      }
      if (isHttpUrl(token.href) && label === token.href) {
        return [{ type: 'url', text: label, href: token.href }]
      }
      return [{ type: 'link', text: label, href: token.href, segments }]
    }
    case 'image':
      return token.href ? [{ type: 'link', text: token.text, href: token.href, segments: [{ type: 'text', text: token.text }] }] : []
    case 'br':
      return [{ type: 'text', text: '\n' }]
    case 'html':
      return scanPlainText(token.text)
    default:
      if (hasInlineTokens(token)) return parseInlineTokens(token.tokens)
      return 'text' in token && typeof token.text === 'string' ? scanPlainText(token.text) : []
  }
}

function scanPlainText(text: string): MarkdownInlineSegment[] {
  const matches: Array<{ start: number; end: number; segment: MarkdownInlineSegment }> = []
  collectMatches(text, URL_PATTERN, (raw) => ({
    type: 'url',
    text: raw,
    href: raw
  }), matches)
  collectMatches(text, FILE_REF_PATTERN, (raw) => createFileRefSegment(raw, raw), matches)
  collectMatches(text, ISSUE_REF_PATTERN, (raw) => ({
    type: 'issueRef',
    text: raw,
    id: raw.slice(1)
  }), matches)
  collectMatches(text, STATUS_PATTERN, (raw) => ({
    type: 'status',
    text: raw,
    tone: resolveStatusTone(raw)
  }), matches)
  collectMatches(text, ENV_VAR_PATTERN, (raw) => createEnvVarSegment(raw), matches)
  collectMatches(text, COMMAND_PATTERN, (raw) => ({
    type: 'command',
    text: raw,
    command: raw.trim()
  }), matches)

  const accepted = selectNonOverlappingMatches(matches)
  if (accepted.length === 0) return text ? [{ type: 'text', text }] : []

  const segments: MarkdownInlineSegment[] = []
  let cursor = 0
  for (const match of accepted) {
    if (match.start > cursor) segments.push({ type: 'text', text: text.slice(cursor, match.start) })
    segments.push(match.segment)
    cursor = match.end
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) })
  return mergeTextSegments(segments)
}

function collectMatches(
  text: string,
  pattern: RegExp,
  toSegment: (raw: string, match: RegExpMatchArray) => MarkdownInlineSegment | undefined,
  matches: Array<{ start: number; end: number; segment: MarkdownInlineSegment }>
): void {
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]
    const start = match.index ?? 0
    if (!raw || start < 0) continue
    const segment = toSegment(raw, match)
    if (segment) matches.push({ start, end: start + raw.length, segment })
  }
}

function selectNonOverlappingMatches(
  matches: Array<{ start: number; end: number; segment: MarkdownInlineSegment }>
): Array<{ start: number; end: number; segment: MarkdownInlineSegment }> {
  const ordered = [...matches].sort((a, b) => a.start - b.start || matchPriority(b.segment) - matchPriority(a.segment) || b.end - b.start - (a.end - a.start))
  const selected: Array<{ start: number; end: number; segment: MarkdownInlineSegment }> = []
  for (const match of ordered) {
    if (selected.some((existing) => rangesOverlap(existing, match))) continue
    selected.push(match)
  }
  return selected.sort((a, b) => a.start - b.start)
}

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  return a.start < b.end && b.start < a.end
}

function matchPriority(segment: MarkdownInlineSegment): number {
  if (segment.type === 'url') return 7
  if (segment.type === 'fileRef') return 6
  if (segment.type === 'command') return 5
  if (segment.type === 'envVar') return 4
  if (segment.type === 'issueRef') return 3
  if (segment.type === 'status') return 2
  return 0
}

function createFileRefSegment(
  text: string,
  href: string,
  label?: string
): Extract<MarkdownInlineSegment, { type: 'fileRef' }> {
  const match = LINE_SUFFIX_PATTERN.exec(href)
  const path = match?.groups?.path ?? href
  const line = parsePositiveInt(match?.groups?.line)
  const column = parsePositiveInt(match?.groups?.column)
  const displayText = label ? `${label} (${href})` : text
  return {
    type: 'fileRef',
    text: displayText,
    path,
    ...(label ? { label } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {})
  }
}

function cleanFileHref(href: string): string {
  const withoutScheme = href.replace(/^file:\/\//i, '')
  return withoutScheme.replace(/#L(?<line>\d+)(?:C(?<column>\d+))?$/i, (...args: unknown[]) => {
    const groups = args.at(-1) as { line?: string; column?: string } | undefined
    return groups?.column ? `:${groups.line}:${groups.column}` : `:${groups?.line ?? ''}`
  })
}

function createEnvVarSegment(raw: string): Extract<MarkdownInlineSegment, { type: 'envVar' }> | undefined {
  const name = raw.split('=')[0] ?? raw
  if (!isLikelyEnvVarName(name)) return undefined
  return { type: 'envVar', text: raw, name }
}

function isLikelyEnvVarName(name: string): boolean {
  return name.startsWith('Q_CODE_') || name.includes('_') || KNOWN_ENV_NAMES.has(name)
}

function resolveStatusTone(raw: string): StatusTone {
  const normalized = raw.replace(/[:：]$/u, '').toLowerCase()
  if (['warning', 'warn', '警告'].includes(normalized)) return 'warning'
  if (['success', 'done', 'passed', '成功', '完成', '通过'].includes(normalized)) return 'success'
  return 'error'
}

function renderInlineSegmentPlain(segment: MarkdownInlineSegment): string {
  switch (segment.type) {
    case 'text':
    case 'inlineCode':
    case 'url':
    case 'fileRef':
    case 'issueRef':
    case 'status':
    case 'envVar':
    case 'command':
      return segment.text
    case 'strong':
    case 'emphasis':
      return renderInlineSegmentsPlain(segment.segments)
    case 'link': {
      const label = renderInlineSegmentsPlain(segment.segments) || segment.text
      return segment.href ? `${label} (${segment.href})` : label
    }
  }
}

function renderInlineSegmentAnsi(segment: MarkdownInlineSegment, palette: InlinePalette): string {
  switch (segment.type) {
    case 'text':
      return segment.text
    case 'strong':
      return applyAnsiTextStyle(renderInlineSegmentsAnsi(segment.segments, { theme: resolvePaletteTheme(palette) }), {
        color: palette.strong,
        bold: true
      })
    case 'emphasis':
      return applyAnsiTextStyle(renderInlineSegmentsAnsi(segment.segments, { theme: resolvePaletteTheme(palette) }), {
        color: palette.emphasis,
        italic: true
      })
    case 'inlineCode':
      return applyAnsiTextStyle(segment.text, { color: palette.inlineCode })
    case 'link':
      return [
        applyAnsiTextStyle(segment.text, { color: palette.link, underline: true }),
        applyAnsiTextStyle(` (${segment.href})`, { color: palette.muted })
      ].join('')
    case 'url':
      return applyAnsiTextStyle(segment.text, { color: palette.link, underline: true })
    case 'fileRef':
      return renderFileRefAnsi(segment, palette)
    case 'issueRef':
      return applyAnsiTextStyle(segment.text, { color: palette.issue })
    case 'status':
      return applyAnsiTextStyle(segment.text, {
        color: statusToneColor(segment.tone, palette),
        bold: true
      })
    case 'envVar':
      return applyAnsiTextStyle(segment.text, { color: palette.inlineCode })
    case 'command':
      return applyAnsiTextStyle(segment.text, { color: palette.command, bold: true })
  }
}

function renderFileRefAnsi(
  segment: Extract<MarkdownInlineSegment, { type: 'fileRef' }>,
  palette: InlinePalette
): string {
  const parts = formatFileRefParts(segment)
  const label = parts.label
    ? `${applyAnsiTextStyle(parts.label, { color: palette.link, underline: true })}${applyAnsiTextStyle(' (', { color: palette.muted })}`
    : ''
  const closing = parts.label ? applyAnsiTextStyle(')', { color: palette.muted }) : ''
  return [
    label,
    applyAnsiTextStyle(parts.path, { color: palette.filePath }),
    parts.suffix ? applyAnsiTextStyle(parts.suffix, { color: palette.lineNumber }) : '',
    closing
  ].join('')
}

function mergeTextSegments(segments: MarkdownInlineSegment[]): MarkdownInlineSegment[] {
  const merged: MarkdownInlineSegment[] = []
  for (const segment of segments) {
    const previous = merged[merged.length - 1]
    if (previous?.type === 'text' && segment.type === 'text') {
      previous.text += segment.text
    } else if (segment.type !== 'text' || segment.text.length > 0) {
      merged.push(segment)
    }
  }
  return merged
}

function isLikelyFileRef(value: string): boolean {
  FILE_REF_PATTERN.lastIndex = 0
  const match = FILE_REF_PATTERN.exec(value)
  return match?.[0] === value
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function hasInlineTokens(token: Token): token is Token & { tokens: Token[] } {
  return Array.isArray((token as { tokens?: unknown }).tokens)
}

function statusToneColor(tone: StatusTone, palette: InlinePalette): RgbColor {
  if (tone === 'success') return palette.success
  if (tone === 'warning') return palette.warning
  return palette.error
}

function resolvePaletteTheme(palette: InlinePalette): HighlightThemeMode {
  return palette === LIGHT_INLINE_PALETTE ? 'light' : 'dark'
}

export interface InlinePalette {
  strong: RgbColor
  emphasis: RgbColor
  inlineCode: RgbColor
  link: RgbColor
  filePath: RgbColor
  lineNumber: RgbColor
  issue: RgbColor
  muted: RgbColor
  command: RgbColor
  success: RgbColor
  warning: RgbColor
  error: RgbColor
}

const DARK_INLINE_PALETTE: InlinePalette = {
  strong: rgb(103, 232, 249),
  emphasis: rgb(147, 197, 253),
  inlineCode: rgb(251, 191, 36),
  link: rgb(96, 165, 250),
  filePath: rgb(34, 211, 238),
  lineNumber: rgb(245, 158, 11),
  issue: rgb(216, 180, 254),
  muted: rgb(148, 163, 184),
  command: rgb(125, 211, 252),
  success: rgb(134, 239, 172),
  warning: rgb(251, 191, 36),
  error: rgb(252, 165, 165)
} as const

const LIGHT_INLINE_PALETTE: InlinePalette = {
  strong: rgb(8, 145, 178),
  emphasis: rgb(29, 78, 216),
  inlineCode: rgb(180, 83, 9),
  link: rgb(29, 78, 216),
  filePath: rgb(8, 145, 178),
  lineNumber: rgb(180, 83, 9),
  issue: rgb(147, 51, 234),
  muted: rgb(71, 85, 105),
  command: rgb(29, 78, 216),
  success: rgb(21, 128, 61),
  warning: rgb(180, 83, 9),
  error: rgb(185, 28, 28)
} as const
