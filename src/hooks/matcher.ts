/**
 * Hook 匹配器：按事件名与 matcher 字段判断定义是否应用于当前事件。
 */
import type { HookDefinition, HookEvent, HookMatcher } from './types'

/** 判断 Hook 定义是否匹配给定事件（含 event 与 matcher）。 */
export function matchesHook(definition: HookDefinition, event: HookEvent): boolean {
  if (definition.event !== event.event) return false
  return matchesMatcher(definition.matcher, event)
}

/** 仅根据 matcher 子集判断事件是否命中（event 已由调用方对齐）。 */
export function matchesMatcher(matcher: HookMatcher | undefined, event: HookEvent): boolean {
  if (!matcher) return true
  if (matcher.event && !matchesAny(matcher.event, event.event)) return false
  if (matcher.agentKind && !matchesAny(matcher.agentKind, event.agent.kind)) return false
  if (matcher.agentType && !matchesAny(matcher.agentType, event.agent.agentType ?? '')) return false

  if (matcher.tool) {
    const toolName = 'tool' in event ? event.tool.name : ''
    if (!toolName || !matchesAny(matcher.tool, toolName)) return false
  }

  return true
}

function matchesAny(patterns: string | string[], value: string): boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  return list.some((pattern) => matchesPattern(pattern, value))
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (pattern === value) return true
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}
