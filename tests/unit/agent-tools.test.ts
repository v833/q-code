import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearAllAsyncAgents,
  getAllAsyncAgents
} from '../../src/agents/async-agent-store'
import { clearAgents, setAgents } from '../../src/agents/registry'
import type { AgentRunResult } from '../../src/agents/types'
import { createAgentTool } from '../../src/tools/agent-tools'
import type { RunChildAgentParams } from '../../src/agents/run-agent'
import { ToolRegistry, type ToolDefinition, type ToolExecutionContext } from '../../src/tools/registry'
import { makeMockTool } from '../_helpers/mock-tool'

describe('Agent 工具', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    clearAgents()
    clearAllAsyncAgents()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('把模型等待与超时配置传给同步子 Agent', async () => {
    setAgents([
      {
        agentType: 'general-purpose',
        whenToUse: 'test',
        source: 'built-in',
        getSystemPrompt: () => 'sys'
      }
    ])

    let captured: RunChildAgentParams | undefined
    const tool = createAgentTool(
      {
        createModel: (modelName?: string) => ({ modelName }),
        getDefaultModelName: () => 'main-model',
        getAvailableTools: () => [],
        getModelWaitHeartbeatMs: () => 11,
        getModelSlowRequestWarnMs: () => 31,
        getModelStalledRequestWarnMs: () => 61,
        getModelRequestTimeoutMs: () => 120_000,
        getModelRequestLabel: (modelName) => `${modelName} via https://proxy.example.com`
      },
      async (params) => {
        captured = params
        return makeAgentResult(params.agentDefinition.agentType)
      }
    )

    const abortController = new AbortController()
    await tool.execute(
      { prompt: 'inspect', description: 'inspect' },
      { cwd: '/tmp/project', abortSignal: abortController.signal } satisfies ToolExecutionContext
    )

    expect(captured).toMatchObject({
      modelWaitHeartbeatMs: 11,
      modelSlowRequestWarnMs: 31,
      modelStalledRequestWarnMs: 61,
      modelRequestTimeoutMs: 120_000,
      modelRequestLabel: 'main-model via https://proxy.example.com',
      abortSignal: abortController.signal,
      quiet: true
    })
  })

  it('把同步子 Agent 纳入 SubAgent Monitor 状态表并在完成后隐藏', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-agent-tool-'))
    tempDirs.push(cwd)
    setAgents([
      {
        agentType: 'general-purpose',
        whenToUse: 'test',
        source: 'built-in',
        getSystemPrompt: () => 'sys'
      }
    ])

    const tool = createAgentTool(
      {
        createModel: (modelName?: string) => ({ modelName }),
        getDefaultModelName: () => 'main-model',
        getAvailableTools: () => [],
        getSessionId: () => 'session-1',
        getCwd: () => cwd
      },
      async (params) => {
        params.onProgress?.({ type: 'tool_use', toolName: 'grep' })
        params.onProgress?.({
          type: 'turn_usage',
          turnUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          cumulativeUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          turnCount: 1
        })
        return makeAgentResult(params.agentDefinition.agentType, {
          totalTokens: 3,
          inputTokens: 1,
          outputTokens: 2,
          totalToolUseCount: 1
        })
      }
    )

    const output = await tool.execute(
      { prompt: 'inspect', description: 'inspect' },
      { cwd } satisfies ToolExecutionContext
    )

    expect(String(output)).toContain("Sub-agent 'general-purpose' completed.")
    const entries = getAllAsyncAgents()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      agentType: 'general-purpose',
      description: 'inspect',
      execution: 'foreground',
      status: 'completed',
      lastToolName: 'grep',
      totalTokens: 3,
      toolUseCount: 1
    })
    expect(existsSync(entries[0]!.outputFile)).toBe(true)
    expect(readFileSync(entries[0]!.outputFile, 'utf8')).toContain('"type":"completed"')
  })

  it('只读同步子 Agent 可并行进入 runner', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-agent-tool-'))
    tempDirs.push(cwd)
    setAgents([
      {
        agentType: 'Explore',
        whenToUse: 'read-only scan',
        source: 'built-in',
        tools: ['*'],
        readOnlyOnly: true,
        getSystemPrompt: () => 'sys'
      }
    ])

    let inFlight = 0
    let maxInFlight = 0
    const tool = createAgentTool(
      makeController({
        cwd,
        availableTools: [makeMockTool('read_file', () => 'ok', { isReadOnly: true })]
      }),
      async (params) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 10))
        inFlight--
        return makeAgentResult(params.agentDefinition.agentType)
      }
    )
    const registry = new ToolRegistry({ cwd, quiet: true })
    registry.register(tool)
    const tools = registry.toAISDKFormat({ cwd })

    await Promise.all([
      tools.Agent.execute(
        { prompt: 'scan terminal', description: 'terminal', subagent_type: 'Explore' },
        { toolCallId: 'agent-1', messages: [] }
      ),
      tools.Agent.execute(
        { prompt: 'scan backend', description: 'backend', subagent_type: 'Explore' },
        { toolCallId: 'agent-2', messages: [] }
      )
    ])

    expect(maxInFlight).toBeGreaterThanOrEqual(2)
  })

  it('包含写入工具的同步子 Agent 仍保持串行', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-agent-tool-'))
    tempDirs.push(cwd)
    setAgents([
      {
        agentType: 'general-purpose',
        whenToUse: 'write task',
        source: 'built-in',
        tools: ['*'],
        getSystemPrompt: () => 'sys'
      }
    ])

    let inFlight = 0
    let maxInFlight = 0
    const tool = createAgentTool(
      makeController({
        cwd,
        availableTools: [
          makeMockTool('read_file', () => 'ok', { isReadOnly: true }),
          makeMockTool('write_file', () => 'ok', { isReadOnly: false })
        ]
      }),
      async (params) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 10))
        inFlight--
        return makeAgentResult(params.agentDefinition.agentType)
      }
    )
    const registry = new ToolRegistry({ cwd, quiet: true })
    registry.register(tool)
    const tools = registry.toAISDKFormat({ cwd })

    await Promise.all([
      tools.Agent.execute(
        { prompt: 'write a', description: 'write-a' },
        { toolCallId: 'agent-1', messages: [] }
      ),
      tools.Agent.execute(
        { prompt: 'write b', description: 'write-b' },
        { toolCallId: 'agent-2', messages: [] }
      )
    ])

    expect(maxInFlight).toBe(1)
  })
})

function makeController(args: {
  cwd?: string
  availableTools?: ToolDefinition[]
} = {}) {
  return {
    createModel: (modelName?: string) => ({ modelName }),
    getDefaultModelName: () => 'main-model',
    getAvailableTools: () => args.availableTools ?? [],
    getSessionId: () => 'session-1',
    getCwd: () => args.cwd ?? '/tmp/project'
  }
}

function makeAgentResult(
  agentType: string,
  overrides: Partial<Pick<
    AgentRunResult,
    'totalTokens' | 'inputTokens' | 'outputTokens' | 'totalToolUseCount'
  >> = {}
): AgentRunResult {
  return {
    agentType,
    finalText: 'done',
    messages: [{ role: 'assistant', content: 'done' }],
    totalToolUseCount: overrides.totalToolUseCount ?? 0,
    totalDurationMs: 1,
    totalTokens: overrides.totalTokens ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    turnCount: 1,
    warnings: []
  }
}
