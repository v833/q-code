/** TUI 等待态：带主题色 ✢ 前缀与省略号的单行加载文案。 */
import React from 'react'
import { Text } from 'ink'
import { animeTheme } from '../theme/index'

/** @param label 显示在省略号前的状态文案 */
export function SpinnerText({ label }: { label: string }): React.JSX.Element {
  return (
    <Text>
      <Text color={animeTheme.duck}>✢ </Text>
      <Text color={animeTheme.candy}>{label}</Text>
      <Text color={animeTheme.blush}>...</Text>
    </Text>
  )
}
