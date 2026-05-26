/**
 * 斜杠命令补全列表：按 category 分组并高亮当前选中项。
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { SlashCommandSuggestion } from '../../slash'
import { animeTheme } from '../theme/index'

/** 带选中态的斜杠建议项（由 {@link TerminalApp} 注入 `isSelected`）。 */
export interface RenderedCommandSuggestion extends SlashCommandSuggestion {
  isSelected?: boolean
}

/** 无建议时返回 `null`。 */
export function CommandSuggestions({
  suggestions,
  notice
}: {
  suggestions: RenderedCommandSuggestion[]
  notice?: string
}): React.JSX.Element | null {
  if (suggestions.length === 0 && !notice) return null
  const groups = groupSuggestions(suggestions)

  return (
    <Box marginTop={1} flexDirection="column">
      {notice ? <Text color={animeTheme.textDim}>  {notice}</Text> : null}
      {groups.map((group) => (
        <Box key={group.category} flexDirection="column">
          <Text color={animeTheme.textDim}>  {group.category}</Text>
          {group.items.map((item) => (
            <Box key={item.name} marginLeft={2}>
              <Text color={item.isSelected ? animeTheme.duck : animeTheme.textDim}>
                {item.isSelected ? '› ' : '  '}
                {item.name.padEnd(18)}
              </Text>
              <Text color={item.isSelected ? animeTheme.cream : animeTheme.textDim}>{item.description}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function groupSuggestions(suggestions: RenderedCommandSuggestion[]): Array<{
  category: string
  items: RenderedCommandSuggestion[]
}> {
  const groups = new Map<string, RenderedCommandSuggestion[]>()
  for (const suggestion of suggestions) {
    const category = suggestion.category ?? 'Other'
    groups.set(category, [...(groups.get(category) ?? []), suggestion])
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }))
}
