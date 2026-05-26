/**
 * 进程内 Agent 定义注册表。
 *
 * `bootstrapAgents` 在启动时调用 `setAgents` 填充；`Agent` 工具与
 * system prompt 通过 `findAgent` / `getAllAgents` 查询。
 */
import type { AgentDefinition } from './types'

const agents = new Map<string, AgentDefinition>()
let initialized = false

/** 用给定列表替换整个注册表，并标记为已初始化。 */
export function setAgents(definitions: AgentDefinition[]): void {
  agents.clear()
  for (const definition of definitions) {
    agents.set(definition.agentType, definition)
  }
  initialized = true
}

/** 是否已通过 `setAgents` 完成至少一次引导。 */
export function isAgentsInitialized(): boolean {
  return initialized
}

/** 返回当前已注册的全部 Agent 定义副本。 */
export function getAllAgents(): AgentDefinition[] {
  return [...agents.values()]
}

/** 按 `agentType` 查找定义；不存在时返回 `undefined`。 */
export function findAgent(agentType: string): AgentDefinition | undefined {
  return agents.get(agentType)
}

/** 清空注册表并重置初始化标志（主要用于测试）。 */
export function clearAgents(): void {
  agents.clear()
  initialized = false
}
