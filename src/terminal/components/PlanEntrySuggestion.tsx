/**
 * Plan Mode 入口建议面板：在 TUI 内保留原始请求，并提供 Enter/Esc 两条自然路径。
 */
import React from 'react'
import { Box, Text } from 'ink'
import { animeTheme } from '../theme/index'

/** TUI 中待确认的 Plan Mode 入口建议。 */
export interface PlanEntrySuggestionState {
  request: string
  reason: string
}

/** 渲染 Plan Mode 入口建议确认条。 */
export function PlanEntrySuggestion({
  suggestion
}: {
  suggestion?: PlanEntrySuggestionState
}): React.JSX.Element | null {
  if (!suggestion) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={animeTheme.lavender}>
        {'  '}Plan 建议: {suggestion.reason}
      </Text>
      <Text color={animeTheme.textDim}>
        {'  '}Enter 进入 Plan 并继续原请求 · Esc 直接按普通模式执行
      </Text>
      <Text color={animeTheme.textDim} wrap="truncate-end">
        {'  '}请求: {suggestion.request}
      </Text>
    </Box>
  )
}
