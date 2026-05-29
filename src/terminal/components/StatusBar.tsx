/**
 * 状态栏：Agent 状态、可选详情（上下文条、用量、进度、后台 Agent、JIT 提示）。
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { TerminalState } from '../state'
import { statusLabel } from '../utils/format'
import { animeTheme, statusColor } from '../theme/index'
import { ContextMeter } from './ContextMeter'

/** 主状态栏组件。 */
export function StatusBar({
  state,
  isBusy,
  hasStreamingAssistant
}: {
  state: TerminalState
  isBusy: boolean
  hasStreamingAssistant: boolean
}): React.JSX.Element {
  const runningAgents = state.backgroundAgents.filter((agent) => agent.status === 'running').length
  const chips = [
    state.sessionInfo?.agentMode ? `mode ${state.sessionInfo.agentMode}` : '',
    state.sessionInfo?.modelName ? `model ${shortModelName(state.sessionInfo.modelName)}` : '',
    state.sessionInfo?.cacheMode ? `cache ${state.sessionInfo.cacheMode}` : '',
    state.sessionInfo?.taskMode ? `tasks ${state.sessionInfo.taskMode}` : '',
    state.sessionInfo?.duckPersona ? `ya ${state.sessionInfo.duckPersona}` : '',
    state.usage ? `tokens ${formatCompactNumber(state.usage.totalTokens)}` : '',
    runningAgents ? `bg ${runningAgents}` : '',
    state.sessionInfo?.sessionId ? `session ${shortSessionId(state.sessionInfo.sessionId)}` : ''
  ].filter(Boolean)

  return (
    <Box marginTop={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={statusColor(state.status)}>  ✧ 状态: {statusLabel(state.status, state.statusText)}</Text>
        {state.statusDetailsVisible && chips.length > 0 ? (
          <Text color={animeTheme.textDim} wrap="truncate-end">{chips.join(' · ')}</Text>
        ) : null}
      </Box>
      {state.statusDetailsVisible ? (
        <Box marginLeft={2} gap={1}>
          <Text color={animeTheme.textDim}>Context</Text>
          <ContextMeter usage={state.contextUsage} />
          {state.usage ? (
            <Text color={animeTheme.textDim}>
              Usage in/out {formatCompactNumber(state.usage.inputTokens)}/
              {formatCompactNumber(state.usage.outputTokens)}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {state.progressItems.length > 0 ? <ProgressSummary state={state} /> : null}
      {state.backgroundAgents.length > 0 ? <BackgroundAgentSummary state={state} /> : null}
      {state.statusDetailsVisible && state.jitMessages.length > 0 ? (
        <Text color={animeTheme.textDim}>  JIT: {state.jitMessages[state.jitMessages.length - 1]}</Text>
      ) : null}
    </Box>
  )
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function shortModelName(value: string): string {
  return value.length > 24 ? `...${value.slice(-21)}` : value
}

function shortSessionId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value
}

function ProgressSummary({ state }: { state: TerminalState }): React.JSX.Element {
  const done = state.progressItems.filter((item) => item.status === 'completed').length
  const active = state.progressItems.find((item) => item.status === 'in_progress')
  const label = active?.activeForm ?? active?.content ?? `${done}/${state.progressItems.length} done`

  return (
    <Text color={animeTheme.textDim}>
      {'  '}Progress {done}/{state.progressItems.length}: {label}
    </Text>
  )
}

function BackgroundAgentSummary({ state }: { state: TerminalState }): React.JSX.Element {
  const running = state.backgroundAgents.filter((agent) => agent.status === 'running')
  const latest = running[0] ?? state.backgroundAgents[state.backgroundAgents.length - 1]
  if (!latest) return <Text />

  const detail = [
    latest.description,
    latest.lastToolName ? `tool=${latest.lastToolName}` : '',
    latest.worktreeBranch ? `branch=${latest.worktreeBranch}` : ''
  ].filter(Boolean).join(' · ')

  return (
    <Text color={latest.status === 'failed' ? animeTheme.danger : animeTheme.textDim}>
      {'  '}Background {running.length}/{state.backgroundAgents.length}: {latest.agentId} [{latest.status}] {detail}
    </Text>
  )
}
