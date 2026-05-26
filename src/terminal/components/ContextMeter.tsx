/**
 * 上下文 token 占用进度条（█/░），按 warning/blocking 变色。
 */
import React from 'react'
import { Text } from 'ink'
import type { TerminalContextUsage } from '../state'
import { animeTheme } from '../theme/index'

/** 无 `usage` 时显示 pending 占位。 */
export function ContextMeter({ usage }: { usage?: TerminalContextUsage }): React.JSX.Element {
  if (!usage) return <Text dimColor>context pending</Text>
  const pct = Math.round((usage.used / usage.limit) * 100)
  const width = 14
  const filled = Math.min(width, Math.round((pct / 100) * width))
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const color =
    usage.state === 'blocking' || usage.state === 'error'
      ? animeTheme.danger
      : usage.state === 'warning'
        ? animeTheme.duck
        : animeTheme.mint
  return (
    <Text color={color}>
      {bar} {pct}%
    </Text>
  )
}
