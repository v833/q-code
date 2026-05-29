/**
 * 终端等宽布局用的字素宽度计算：CJK/emoji 双宽、组合字符与 ANSI 剥离。
 */

/** 计算字符串在终端中的显示列宽（忽略 ANSI 转义）。 */
export function stringDisplayWidth(text: string): number {
  let width = 0
  for (const char of splitGraphemes(stripAnsi(text))) {
    width += graphemeDisplayWidth(char)
  }
  return width
}

/** 右侧空格填充至目标显示宽度。 */
export function padDisplayEnd(text: string, width: number): string {
  const padding = Math.max(0, width - stringDisplayWidth(text))
  return `${text}${' '.repeat(padding)}`
}

/** 左侧空格填充至目标显示宽度。 */
export function padDisplayStart(text: string, width: number): string {
  const padding = Math.max(0, width - stringDisplayWidth(text))
  return `${' '.repeat(padding)}${text}`
}

/** 居中空格填充至目标显示宽度。 */
export function padDisplayCenter(text: string, width: number): string {
  const padding = Math.max(0, width - stringDisplayWidth(text))
  const left = Math.floor(padding / 2)
  const right = padding - left
  return `${' '.repeat(left)}${text}${' '.repeat(right)}`
}

/** 按显示宽度截断并在末尾加省略号 `…`。 */
export function clipDisplayWidth(text: string, width: number): string {
  if (stringDisplayWidth(text) <= width) return text
  if (width <= 0) return ''
  if (width === 1) return '…'

  let output = ''
  let used = 0
  for (const char of splitGraphemes(text)) {
    const charWidth = graphemeDisplayWidth(char)
    if (used + charWidth > width - 1) break
    output += char
    used += charWidth
  }
  return `${output}…`
}

/** 按显示宽度保留尾部并在开头加省略号 `…`。 */
export function clipDisplayWidthStart(text: string, width: number): string {
  if (stringDisplayWidth(text) <= width) return text
  if (width <= 0) return ''
  if (width === 1) return '…'

  let output = ''
  let used = 0
  for (const char of splitGraphemes(text).reverse()) {
    const charWidth = graphemeDisplayWidth(char)
    if (used + charWidth > width - 1) break
    output = `${char}${output}`
    used += charWidth
  }
  return `…${output}`
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

/** 按 Unicode 字素簇切分（优先 `Intl.Segmenter`）。 */
export function splitGraphemes(value: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const Segmenter = Intl.Segmenter
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(value), (segment) => segment.segment)
  }
  return Array.from(value)
}

/** 单个字素簇的终端显示列宽（含 ZWJ emoji 启发式）。 */
export function graphemeDisplayWidth(value: string): number {
  if (!value) return 0
  if (value.includes('\u200d')) return 2
  let width = 0
  for (const char of Array.from(value)) {
    width += charDisplayWidth(char)
  }
  return width
}

function charDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0)
  if (codePoint === undefined) return 0
  if (codePoint === 0) return 0
  if (codePoint === 0x200d) return 0
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  if (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) return 0
  if (isCombining(codePoint)) return 0
  return isWide(codePoint) ? 2 : 1
}

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  )
}

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  )
}
