import { afterEach, describe, expect, it } from 'vitest'
import { clearAgents, setAgents } from '../../src/agents/registry'
import type { AgentRunResult } from '../../src/agents/types'
import { createAgentTool } from '../../src/tools/agent-tools'
import type { RunChildAgentParams } from '../../src/agents/run-agent'
import type { ToolExecutionContext } from '../../src/tools/registry'

describe('Agent 工具', () => {
  afterEach(() => {
    clearAgents()
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

    await tool.execute(
      { prompt: 'inspect', description: 'inspect' },
      { cwd: '/tmp/project' } satisfies ToolExecutionContext
    )

    expect(captured).toMatchObject({
      modelWaitHeartbeatMs: 11,
      modelSlowRequestWarnMs: 31,
      modelStalledRequestWarnMs: 61,
      modelRequestTimeoutMs: 120_000,
      modelRequestLabel: 'main-model via https://proxy.example.com'
    })
  })
})

function makeAgentResult(agentType: string): AgentRunResult {
  return {
    agentType,
    finalText: 'done',
    messages: [{ role: 'assistant', content: 'done' }],
    totalToolUseCount: 0,
    totalDurationMs: 1,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    turnCount: 1,
    warnings: []
  }
}
