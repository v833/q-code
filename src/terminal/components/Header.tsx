/**
 * TUI 顶栏：标题、会话 ID、压缩后的 cwd 与快捷键说明。
 */
import React from 'react'
import { Box, Text } from 'ink'
import { compactPath } from '../utils/format'
import { animeTheme } from '../theme/index'

/** 顶栏展示组件。 */
export function Header({
  title,
  sessionId,
  cwd
}: {
  title: string
  sessionId?: string
  cwd?: string
}): React.JSX.Element {
  const compactCwd = cwd ? compactPath(cwd, 54) : ''
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={animeTheme.candy}>{`✦ ${title}`}</Text>
        {sessionId ? <Text color={animeTheme.textDim}>{`  episode ${sessionId}`}</Text> : null}
        <Text color={animeTheme.textDim}>{compactCwd ? `  ${compactCwd}` : ''}</Text>
      </Box>
      <Box>
        <Text color={animeTheme.textDim}>Enter 发送 · Shift+Enter/Ctrl+J 换行 · Ctrl+R 搜历史 · Esc 清空/恢复 · Ctrl+C 中断/退出</Text>
      </Box>
    </Box>
  )
}
