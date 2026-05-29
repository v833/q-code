import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearCompletedAsyncAgents,
  clearAllAsyncAgents,
  completeAsyncAgent,
  failAsyncAgent,
  getAllAsyncAgents,
  killAsyncAgent,
  registerAsyncAgent
} from '../../src/agents/async-agent-store'
import {
  canKillAgent,
  filterVisibleAgentMonitorAgents,
  formatSubAgentWaitHint,
  formatAgentRuntime,
  getSubAgentMonitorToggleAction,
  getRunningAgentIds,
  getVisibleAgentOutputLines,
  readTaskOutputTail,
  shouldShowSubAgentWaitHint,
  sortAgentMonitorAgents
} from '../../src/terminal/agent-monitor'
import type { TerminalBackgroundAgentItem } from '../../src/terminal/events'

describe('agent monitor helpers', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    clearAllAsyncAgents()
  })

  it('sorts running agents first and then by newest startedAt', () => {
    const agents: TerminalBackgroundAgentItem[] = [
      agent('done-old', 'completed', '2026-05-29T01:00:00.000Z'),
      agent('run-old', 'running', '2026-05-29T02:00:00.000Z'),
      agent('run-new', 'running', '2026-05-29T03:00:00.000Z')
    ]

    expect(sortAgentMonitorAgents(agents).map((item) => item.agentId)).toEqual([
      'run-new',
      'run-old'
    ])
    expect(filterVisibleAgentMonitorAgents(agents).map((item) => item.agentId)).toEqual([
      'run-old',
      'run-new'
    ])
  })

  it('formats running elapsed time from startedAt', () => {
    const item = agent('a1', 'running', '2026-05-29T00:00:00.000Z')

    expect(formatAgentRuntime(item, Date.parse('2026-05-29T00:01:05.000Z'))).toBe('1m 5s')
  })

  it('returns only running agent ids and killability', () => {
    const agents = [
      agent('a1', 'running'),
      { ...agent('a2', 'running'), execution: 'foreground' as const },
      agent('a3', 'failed')
    ]

    expect(getRunningAgentIds(agents)).toEqual(['a1'])
    expect(canKillAgent(agents[0])).toBe(true)
    expect(canKillAgent(agents[1])).toBe(false)
    expect(canKillAgent(agents[2])).toBe(false)
  })

  it('shows a wait hint only while busy with running SubAgents', () => {
    const agents = [
      agent('agent-running-1', 'running'),
      agent('agent-running-2', 'running'),
      agent('agent-failed', 'failed')
    ]

    expect(shouldShowSubAgentWaitHint(agents, true, false)).toBe(true)
    expect(shouldShowSubAgentWaitHint(agents, false, false)).toBe(false)
    expect(shouldShowSubAgentWaitHint(agents, true, true)).toBe(false)
    expect(shouldShowSubAgentWaitHint([agent('agent-failed', 'failed')], true, false)).toBe(false)
    expect(formatSubAgentWaitHint(agents)).toContain('2 running')
    expect(formatSubAgentWaitHint(agents)).toContain('Ctrl+A')
  })

  it('maps Ctrl+A to open while waiting and close whenever the monitor is open', () => {
    const runningAgents = [agent('agent-running', 'running')]
    const failedAgents = [agent('agent-failed', 'failed')]

    expect(getSubAgentMonitorToggleAction({
      agents: runningAgents,
      isBusy: true,
      monitorOpen: false
    })).toBe('open')
    expect(getSubAgentMonitorToggleAction({
      agents: failedAgents,
      isBusy: true,
      monitorOpen: false
    })).toBeUndefined()
    expect(getSubAgentMonitorToggleAction({
      agents: failedAgents,
      isBusy: false,
      monitorOpen: true
    })).toBe('close')
  })

  it('slices detail output from the tail with scroll offset', () => {
    const lines = Array.from({ length: 8 }, (_, index) => ({
      text: `line ${index}`,
      tone: 'text' as const
    }))

    expect(getVisibleAgentOutputLines(lines, 3, 0).map((line) => line.text)).toEqual([
      'line 5',
      'line 6',
      'line 7'
    ])
    expect(getVisibleAgentOutputLines(lines, 3, 2).map((line) => line.text)).toEqual([
      'line 3',
      'line 4',
      'line 5'
    ])
  })

  it('reads and formats task output JSONL', async () => {
    const file = tempFile(
      [
        JSON.stringify({
          timestamp: '2026-05-29T01:02:03.000Z',
          type: 'started',
          agentType: 'Explore',
          description: 'scan repo',
          prompt: 'go'
        }),
        JSON.stringify({
          timestamp: '2026-05-29T01:02:04.000Z',
          type: 'tool_use',
          toolName: 'grep'
        }),
        JSON.stringify({
          timestamp: '2026-05-29T01:02:05.000Z',
          type: 'completed',
          finalText: 'done',
          durationMs: 2000,
          totalTokens: 1200,
          toolUseCount: 1
        })
      ].join('\n')
    )

    const tail = await readTaskOutputTail(file)

    expect(tail.warnings).toEqual([])
    expect(tail.lines.map((line) => line.text)).toEqual([
      'started Explore · scan repo',
      'tool use: grep',
      'completed · duration 2s · tools 1 · tokens 1.2k',
      'final done'
    ])
  })

  it('skips broken JSONL lines and reports a warning', async () => {
    const file = tempFile(
      [
        '{"type":"text","timestamp":"2026-05-29T01:02:03.000Z","text":"ok"}',
        '{broken',
        '{"type":"failed","timestamp":"2026-05-29T01:02:04.000Z","error":"boom","durationMs":1000}'
      ].join('\n')
    )

    const tail = await readTaskOutputTail(file)

    expect(tail.lines.map((line) => line.text)).toEqual([
      'text ok',
      'failed · duration 1s · boom'
    ])
    expect(tail.warnings).toEqual(['1 行 output JSONL 无法解析，已跳过。'])
  })

  it('tails large files instead of reading all content', async () => {
    const file = tempFile(
      [
        JSON.stringify({ type: 'text', text: 'old'.repeat(2000) }),
        JSON.stringify({ type: 'text', text: 'tail' })
      ].join('\n')
    )

    const tail = await readTaskOutputTail(file, { maxBytes: 128 })

    expect(tail.truncatedBytes).toBeGreaterThan(0)
    expect(tail.warnings[0]).toContain('output 文件较大')
    expect(tail.lines.at(-1)?.text).toBe('text tail')
  })

  it('returns a friendly warning for missing output files', async () => {
    const tail = await readTaskOutputTail(join(tmpdir(), 'q-code-missing-output-file'))

    expect(tail.lines).toEqual([])
    expect(tail.warnings[0]).toContain('output 文件不存在')
  })

  it('uses async-agent-store kill semantics for running and completed agents', () => {
    const first = registerAsyncAgent({
      agentId: 'agent-1',
      agentType: 'Explore',
      description: 'one',
      prompt: 'go',
      outputFile: 'agent-1.output'
    })
    registerAsyncAgent({
      agentId: 'agent-2',
      agentType: 'Explore',
      description: 'two',
      prompt: 'go',
      outputFile: 'agent-2.output'
    })

    expect(killAsyncAgent(first.agentId)).toBe(true)
    expect(killAsyncAgent(first.agentId)).toBe(false)
    expect(getAllAsyncAgents().map((entry) => [entry.agentId, entry.status])).toEqual([
      ['agent-1', 'killed'],
      ['agent-2', 'running']
    ])
  })

  it('clears only completed async agents from the store', () => {
    registerAsyncAgent({
      agentId: 'agent-completed',
      agentType: 'Explore',
      description: 'done',
      prompt: 'go',
      outputFile: 'agent-completed.output'
    })
    registerAsyncAgent({
      agentId: 'agent-running',
      agentType: 'Explore',
      description: 'run',
      prompt: 'go',
      outputFile: 'agent-running.output'
    })
    registerAsyncAgent({
      agentId: 'agent-failed',
      agentType: 'Explore',
      description: 'fail',
      prompt: 'go',
      outputFile: 'agent-failed.output'
    })

    completeAsyncAgent('agent-completed', {
      agentType: 'Explore',
      finalText: 'done',
      messages: [],
      totalToolUseCount: 1,
      totalDurationMs: 1000,
      totalTokens: 100,
      inputTokens: 40,
      outputTokens: 60,
      turnCount: 1,
      warnings: []
    })
    failAsyncAgent('agent-failed', 'boom', 500)

    expect(clearCompletedAsyncAgents()).toBe(1)
    expect(getAllAsyncAgents().map((entry) => [entry.agentId, entry.status])).toEqual([
      ['agent-running', 'running'],
      ['agent-failed', 'failed']
    ])
  })

  function tempFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'q-code-agent-monitor-'))
    tempDirs.push(dir)
    const file = join(dir, 'agent.output')
    writeFileSync(file, `${content}\n`, 'utf8')
    return file
  }

  function agent(
    agentId: string,
    status: TerminalBackgroundAgentItem['status'],
    startedAt = '2026-05-29T00:00:00.000Z'
  ): TerminalBackgroundAgentItem {
    return {
      agentId,
      agentType: 'Explore',
      description: agentId,
      startedAt,
      status,
      toolUseCount: status === 'running' ? 1 : 2
    }
  }
})
