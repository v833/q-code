/**
 * 用户输入行提示符主题（前缀与 glyph）。
 */

/** 提示符静态配置。 */
export const promptTheme = {
  prefix: '',
  glyph: '❯'
} as const

/** 返回带尾随空格的输入提示符字符串。 */
export function formatPromptGlyph(): string {
  return `${promptTheme.prefix}${promptTheme.glyph} `
}
