import { describe, expect, it } from 'vitest'
import { buildChildPrompt } from '../../src/agents/run-agent'
import type { AgentDefinition } from '../../src/agents/types'
import { ToolRegistry } from '../../src/tools/registry'

describe('runChildAgent prompt', () => {
  it('uses the shared stable prompt pipes for SubAgent prompts', () => {
    const registry = new ToolRegistry()
    const childPrompt = buildChildPrompt({
      definition: makeAgentDefinition(),
      registry,
      agentMdContext: 'PROJECT_RULES'
    })

    expect(childPrompt.systemPrompt).toContain('PROJECT_RULES')
    expect(childPrompt.systemPrompt).toContain('[SubAgent]')
    expect(childPrompt.systemPrompt).toContain('[Behavior Examples / 行为示例]')
    expect(childPrompt.systemPrompt).toContain('tool_search')
    expect(childPrompt.systemPrompt).not.toContain('SubAgents discovery')
  })
})

function makeAgentDefinition(): AgentDefinition {
  return {
    agentType: 'Explore',
    whenToUse: 'test',
    source: 'built-in',
    getSystemPrompt: () => '只读探索。'
  }
}
