/**
 * 根据 `AgentDefinition` 的工具白名单/黑名单，从主会话可用工具集中
 * 解析出子 Agent 实际可调用的 `ToolDefinition` 列表。
 */
import type { ToolDefinition } from '../tools/registry'
import type { AgentDefinition } from './types'

/** `Agent` 工具自身的名称；子 Agent 永远不能递归调用。 */
export const AGENT_TOOL_NAME = 'Agent'

/**
 * 所有子 Agent 一律禁止的工具（计划模式、嵌套 Agent 等）。
 * 与定义里的 `disallowedTools` 取并集。
 */
export const ALWAYS_DISALLOWED_AGENT_TOOLS = [
  AGENT_TOOL_NAME,
  'enter_plan_mode',
  'plan_write',
  'exit_plan_mode'
]

/** `resolveAgentTools` 的返回值。 */
export interface ResolvedAgentTools {
  /** 是否使用通配（未指定 tools、空数组或仅 `*`）。 */
  hasWildcard: boolean
  resolvedTools: ToolDefinition[]
  /** 白名单中请求了但当前不可用的工具名。 */
  invalidTools: string[]
}

/**
 * 解析子 Agent 工具集。
 *
 * - 通配：在 `disallowed` 与 `readOnlyOnly` 过滤后的全部候选工具。
 * - 白名单：按声明顺序去重；未知名记入 `invalidTools`。
 */
export function resolveAgentTools(
  agentDefinition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'readOnlyOnly'>,
  availableTools: ToolDefinition[]
): ResolvedAgentTools {
  const disallowed = new Set([
    ...ALWAYS_DISALLOWED_AGENT_TOOLS,
    ...(agentDefinition.disallowedTools ?? [])
  ])
  const candidates = availableTools.filter((tool) => {
    if (disallowed.has(tool.name)) return false
    if (agentDefinition.readOnlyOnly && tool.isReadOnly !== true) return false
    return true
  })

  const tools = agentDefinition.tools
  const hasWildcard =
    !tools || tools.length === 0 || (tools.length === 1 && tools[0] === '*')
  if (hasWildcard) {
    return { hasWildcard: true, resolvedTools: candidates, invalidTools: [] }
  }

  const byName = new Map(candidates.map((tool) => [tool.name, tool]))
  const seen = new Set<string>()
  const resolvedTools: ToolDefinition[] = []
  const invalidTools: string[] = []

  for (const requested of tools) {
    const tool = byName.get(requested)
    if (!tool) {
      invalidTools.push(requested)
      continue
    }
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    resolvedTools.push(tool)
  }

  return { hasWildcard: false, resolvedTools, invalidTools }
}
