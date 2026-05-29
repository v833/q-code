/**
 * 终端 ANSI 样式 helper：统一 24-bit 前景色、基础样式与禁色降级。
 */

/** 24-bit RGB 颜色。 */
export interface RgbColor {
  r: number
  g: number
  b: number
}

/** 可组合的 ANSI 文本样式。 */
export interface AnsiTextStyle {
  color?: RgbColor
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

const RESET = '\x1b[0m'

/**
 * 给文本应用 ANSI 样式；`noColor` 为 true 或无样式时返回原文。
 */
export function applyAnsiTextStyle(text: string, style: AnsiTextStyle, noColor = false): string {
  if (text.length === 0 || noColor) return text

  const codes: string[] = []
  if (style.bold) codes.push('1')
  if (style.dim) codes.push('2')
  if (style.italic) codes.push('3')
  if (style.underline) codes.push('4')
  if (style.color) {
    codes.push(`38;2;${clampColor(style.color.r)};${clampColor(style.color.g)};${clampColor(style.color.b)}`)
  }

  if (codes.length === 0) return text
  return `\x1b[${codes.join(';')}m${text}${RESET}`
}

/** 简短的 RGB 工厂，调用处更易读。 */
export function rgb(r: number, g: number, b: number): RgbColor {
  return { r, g, b }
}

/** 转成 Ink/Chalk 支持的 `rgb(r,g,b)` 颜色字符串。 */
export function rgbToInkColor(color: RgbColor): string {
  return `rgb(${clampColor(color.r)},${clampColor(color.g)},${clampColor(color.b)})`
}

function clampColor(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}
