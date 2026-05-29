/**
 * Agent Monitor 面板：SubAgent 列表、详情状态与 `.output` tail 展示。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import type { TerminalBackgroundAgentItem } from '../events'
import type { TerminalAgentMonitorState } from '../state'
import {
  canKillAgent,
  formatAgentRuntime,
  formatCompactNumber,
  getVisibleAgentOutputLines,
  readTaskOutputTail,
  type AgentOutputLine,
  type AgentOutputTail
} from '../agent-monitor'
import { animeTheme } from '../theme/index'

/** Agent Monitor 面板 props。 */
export interface AgentMonitorPanelProps {
  monitor?: TerminalAgentMonitorState
  agents: TerminalBackgroundAgentItem[]
  onOutputLineCount?: (agentId: string, lineCount: number) => void
}

/** 渲染 SubAgent Monitor；未打开时不输出任何内容。 */
export function AgentMonitorPanel({
  monitor,
  agents,
  onOutputLineCount
}: AgentMonitorPanelProps): React.JSX.Element | null {
  const [tail, setTail] = useState<AgentOutputTail | undefined>(undefined)
  const { stdout } = useStdout()
  const onOutputLineCountRef = useRef(onOutputLineCount)
  const detailAgent =
    monitor?.view === 'detail'
      ? agents.find((agent) => agent.agentId === monitor.agentId)
      : undefined

  useEffect(() => {
    onOutputLineCountRef.current = onOutputLineCount
  }, [onOutputLineCount])

  useEffect(() => {
    if (!detailAgent) {
      setTail(undefined)
      return undefined
    }

    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const load = async () => {
      const nextTail = await readTaskOutputTail(detailAgent.outputFile)
      if (!cancelled) {
        setTail(nextTail)
        onOutputLineCountRef.current?.(detailAgent.agentId, nextTail.lines.length)
      }
    }

    void load()
    if (detailAgent.status === 'running') {
      timer = setInterval(() => void load(), 1200)
    }

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [
    detailAgent?.agentId,
    detailAgent?.durationMs,
    detailAgent?.outputFile,
    detailAgent?.status,
    detailAgent?.toolUseCount,
    detailAgent?.totalTokens
  ])

  if (!monitor) return null
  if (monitor.view === 'detail') {
    const maxOutputRows = Math.max(6, Math.min(18, (stdout.rows ?? 28) - 15))
    return (
      <AgentDetailView
        agent={detailAgent}
        monitor={monitor}
        tail={tail}
        maxOutputRows={maxOutputRows}
      />
    )
  }
  return <AgentListView monitor={monitor} agents={agents} />
}

function AgentListView({
  monitor,
  agents
}: {
  monitor: Extract<TerminalAgentMonitorState, { view: 'list' }>
  agents: TerminalBackgroundAgentItem[]
}): React.JSX.Element {
  const runningCount = agents.filter((agent) => agent.status === 'running').length
  const killableCount = agents.filter(canKillAgent).length

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={animeTheme.sky}>SubAgents</Text>
        <Text color={animeTheme.textDim}> · {runningCount}/{agents.length} running</Text>
      </Box>
      <Box marginTop={1}>
        <Box width={3}><Text color="yellow"> </Text></Box>
        <Box width={12}><Text color="cyan">ID</Text></Box>
        <Box width={12}><Text color="cyan">Type</Text></Box>
        <Box width={22}><Text color="cyan">Description</Text></Box>
        <Box width={8}><Text color="cyan">Mode</Text></Box>
        <Box width={11}><Text color="cyan">Status</Text></Box>
        <Box width={8}><Text color="cyan">Time</Text></Box>
        <Box width={13}><Text color="cyan">Tool</Text></Box>
        <Box width={8}><Text color="cyan">Tools</Text></Box>
        <Box width={8}><Text color="cyan">Tokens</Text></Box>
        <Text color="cyan">Branch</Text>
      </Box>
      {agents.length === 0 ? (
        <Text color={animeTheme.textDim}>  当前没有可展示的 SubAgent。运行中的同步或后台 SubAgent 会出现在这里。</Text>
      ) : (
        agents.map((agent, index) => {
          const selected = index === monitor.selectedIndex
          return (
            <Box key={agent.agentId}>
              <Box width={3}>
                <Text color={selected ? 'yellow' : statusColor(agent.status)}>
                  {selected ? '›' : agent.status === 'running' ? '●' : '○'}
                </Text>
              </Box>
              <Box width={12}>
                <Text color={selected ? 'white' : 'gray'}>{truncate(agent.agentId, 10)}</Text>
              </Box>
              <Box width={12}>
                <Text color={selected ? 'white' : 'gray'}>{truncate(agent.agentType, 10)}</Text>
              </Box>
              <Box width={22}>
                <Text color={selected ? 'white' : 'gray'}>{truncate(agent.description, 20)}</Text>
              </Box>
              <Box width={8}>
                <Text color="gray">{agent.execution === 'foreground' ? 'fg' : 'bg'}</Text>
              </Box>
              <Box width={11}>
                <Text color={statusColor(agent.status)}>
                  {agent.status === 'failed' && agent.error ? 'failed!' : agent.status}
                </Text>
              </Box>
              <Box width={8}><Text color="gray">{formatAgentRuntime(agent)}</Text></Box>
              <Box width={13}>
                <Text color="gray">
                  {truncate(agent.lastToolName ?? '-', 11)}
                </Text>
              </Box>
              <Box width={8}><Text color="gray">{agent.toolUseCount ?? 0}</Text></Box>
              <Box width={8}><Text color="gray">{formatCompactNumber(agent.totalTokens)}</Text></Box>
              <Text color="gray">{truncate(agent.worktreeBranch ?? '-', 24)}</Text>
            </Box>
          )
        })
      )}
      {monitor.confirmKillAll ? (
        <Text color={animeTheme.danger}>
          {'  '}确认停止全部 {killableCount} 个可停止后台 SubAgent？Enter/y 确认 · Esc/n 取消
        </Text>
      ) : null}
      {monitor.notice ? <Text color={animeTheme.duckShadow}>  {monitor.notice}</Text> : null}
      <Text color={animeTheme.textDim}>
        {'  '}↑/↓ 选择 · Enter 详情 · x 停止后台 · c 清理 completed · Ctrl+X Ctrl+K 停止全部后台 · Esc/Ctrl+A 返回
      </Text>
    </Box>
  )
}

function AgentDetailView({
  agent,
  monitor,
  tail,
  maxOutputRows
}: {
  agent: TerminalBackgroundAgentItem | undefined
  monitor: Extract<TerminalAgentMonitorState, { view: 'detail' }>
  tail: AgentOutputTail | undefined
  maxOutputRows: number
}): React.JSX.Element {
  const visibleLines = useMemo(
    () => getVisibleAgentOutputLines(tail?.lines ?? [], maxOutputRows, monitor.scrollOffset),
    [maxOutputRows, monitor.scrollOffset, tail?.lines]
  )

  if (!agent) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={animeTheme.danger}>Agent 已不在后台列表中。</Text>
        <Text color={animeTheme.textDim}>  Esc 返回列表</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={animeTheme.sky}>{agent.agentType}</Text>
        <Text color={animeTheme.textDim}> / {agent.agentId}</Text>
      </Box>
      <Text color="white">{agent.description}</Text>
      <Text color={animeTheme.textDim}>
        status <Text color={statusColor(agent.status)}>{agent.status}</Text>
        {' '}· mode {agent.execution === 'foreground' ? 'foreground' : 'background'}
        {' '}· elapsed {formatAgentRuntime(agent)}
        {' '}· tools {agent.toolUseCount ?? 0}
        {' '}· turns {agent.turnCount ?? 0}
        {' '}· tokens {formatCompactNumber(agent.totalTokens)}
        {canKillAgent(agent) ? ' · killable' : ''}
      </Text>
      {agent.worktreePath ? (
        <Text color={animeTheme.textDim}>
          worktree {agent.worktreePath} · branch {agent.worktreeBranch ?? '(unknown)'}
        </Text>
      ) : null}
      <Text color={animeTheme.textDim}>output {agent.outputFile ?? '(missing)'}</Text>
      {agent.error ? <Text color={animeTheme.danger}>error {agent.error}</Text> : null}
      {agent.finalText && agent.status === 'completed' ? (
        <Text color={animeTheme.mint}>final {truncate(agent.finalText, 140)}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {tail === undefined ? (
          <Text color={animeTheme.textDim}>  正在读取 output...</Text>
        ) : tail.lines.length === 0 && tail.warnings.length === 0 ? (
          <Text color={animeTheme.textDim}>  output 还没有内容。</Text>
        ) : (
          visibleLines.map((line, index) => (
            <OutputLine key={`${index}-${line.timestamp ?? ''}-${line.text}`} line={line} />
          ))
        )}
      </Box>
      {tail?.warnings.map((warning) => (
        <Text key={warning} color={animeTheme.duckShadow}>  {warning}</Text>
      ))}
      {monitor.notice ? <Text color={animeTheme.duckShadow}>  {monitor.notice}</Text> : null}
      <Text color={animeTheme.textDim}>
        {'  '}Esc 返回 · Ctrl+A 关闭 · x 停止 · ↑/↓ 滚动 · End 跳到底部
        {monitor.scrollOffset > 0 ? ` · 已上滚 ${monitor.scrollOffset} 行` : ' · 跟随尾部'}
      </Text>
    </Box>
  )
}

function OutputLine({ line }: { line: AgentOutputLine }): React.JSX.Element {
  return (
    <Text color={toneColor(line.tone)}>
      {'  '}
      {line.timestamp ? `[${formatTime(line.timestamp)}] ` : ''}
      {line.text}
    </Text>
  )
}

function statusColor(status: TerminalBackgroundAgentItem['status']): string {
  switch (status) {
    case 'running':
      return animeTheme.mint
    case 'completed':
      return animeTheme.sky
    case 'failed':
      return animeTheme.danger
    case 'killed':
      return animeTheme.duckShadow
  }
}

function toneColor(tone: AgentOutputLine['tone']): string {
  switch (tone) {
    case 'success':
      return animeTheme.mint
    case 'error':
      return animeTheme.danger
    case 'warning':
      return animeTheme.duckShadow
    case 'tool':
      return animeTheme.sky
    case 'usage':
      return animeTheme.lavender
    case 'text':
      return 'white'
    case 'info':
      return animeTheme.textDim
  }
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 8)
  return [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ].map((part) => String(part).padStart(2, '0')).join(':')
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}
