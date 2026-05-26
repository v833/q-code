/**
 * Agent 引导：合并内置定义与 `~/.q-code/agents`、`<cwd>/.q-code/agents`
 * 下的自定义 Markdown，写入进程内注册表。
 */
import { getBuiltInAgents } from './built-in'
import { loadAllCustomAgents } from './load-agents-dir'
import { setAgents } from './registry'

/** `bootstrapAgents` 的汇总结果。 */
export interface AgentsBootstrapResult {
  /** 去重后的 Agent 类型总数。 */
  agentCount: number
  customCount: number
  /** 加载自定义 Agent 时的非致命警告。 */
  warnings: string[]
}

/**
 * 加载内置 + 自定义 Agent 并注册。
 * 同名 `agentType` 时后加载项覆盖先加载项（项目级在用户级之后合并，见 `loadAllCustomAgents`）。
 */
export async function bootstrapAgents(cwd: string): Promise<AgentsBootstrapResult> {
  const custom = await loadAllCustomAgents(cwd)
  const definitions = [...getBuiltInAgents(), ...custom.agents]
  setAgents(definitions)

  return {
    agentCount: new Set(definitions.map((agent) => agent.agentType)).size,
    customCount: custom.agents.length,
    warnings: custom.warnings
  }
}
