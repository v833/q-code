/**
 * 内置 SubAgent 定义入口。
 */
import type { AgentDefinition } from '../types'
import { EXPLORE_AGENT } from './explore'
import { GENERAL_PURPOSE_AGENT } from './general-purpose'

/** 返回所有内置 `AgentDefinition`（先于自定义 Agent 注册）。 */
export function getBuiltInAgents(): AgentDefinition[] {
  return [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]
}
