/**
 * TUI 动漫风格调色板：Ink 组件使用的十六进制颜色名。
 */

/** 全局主题色表。 */
export const animeTheme = {
  duck: '#ffd86b',
  duckShadow: '#f6a84f',
  blush: '#ff8bb3',
  candy: '#ff7ab6',
  mint: '#7fe7c4',
  sky: '#8cc8ff',
  lavender: '#b7a8ff',
  cream: '#fff0b8',
  textDim: '#8f9ab7',
  danger: '#ff6b8f'
} as const

/** {@link animeTheme} 的键名联合类型。 */
export type AnimeThemeColor = keyof typeof animeTheme
