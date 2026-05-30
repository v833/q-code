/**
 * 向主 Agent system prompt 注入 SubAgent 目录说明（`<system-reminder>` 块）。
 *
 * 列出当前已注册的 `AgentDefinition`，保持常驻提示简短以稳定 prompt cache 前缀。
 */
import type { AgentDefinition } from './types'

const MAX_DESC_CHARS = 220

/**
 * 生成 SubAgent 能力说明的 system-reminder 文本；无可用 Agent 时返回空字符串。
 */
export function formatAgentsSystemReminder(agents: AgentDefinition[]): string {
  if (agents.length === 0) return ''

  const sorted = [...agents].sort((left, right) => {
    if (left.source === 'built-in' && right.source !== 'built-in') return -1
    if (left.source !== 'built-in' && right.source === 'built-in') return 1
    return left.agentType.localeCompare(right.agentType)
  })

  const lines = sorted.map((agent) => {
    const tags = [agent.source, agent.isolation ? `isolation=${agent.isolation}` : null].filter(
      (tag): tag is string => tag !== null
    )
    return `- ${agent.agentType} [${tags.join(', ')}]: ${truncate(agent.whenToUse, MAX_DESC_CHARS)}`
  })

  return [
    '<system-reminder>',
    'Available sub-agents can be invoked through the `Agent` tool. Each sub-agent runs with a clean message history, a filtered tool set, and returns only a concise summary.',
    'Use sub-agents for focused subtasks that need several tool calls, especially search-heavy or read-heavy work. Do not delegate trivial one-step work.',
    'Sub-agents do not see the main conversation history, so every `prompt` passed to `Agent` must be self-contained.',
    '',
    'Available sub-agents:',
    ...lines,
    '</system-reminder>'
  ].join('\n')
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}
