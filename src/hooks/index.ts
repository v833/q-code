/**
 * Hooks 子系统公共导出：类型、配置加载、匹配器、事件工厂与默认 Runner。
 */
export { DefaultHookRunner } from './runner'
export { loadHookConfigs, getHookSettingsPaths, type HookConfigLoadResult } from './config'
export {
  baseHookEvent,
  createHookEvent,
  createPreToolUseEvent,
  createPostToolUseEvent,
  type HookEventFactoryContext
} from './events'
export { matchesHook, matchesMatcher } from './matcher'
export type {
  HookAgentContext,
  HookAgentKind,
  HookCommandDefinition,
  HookDefinition,
  HookDecision,
  HookEvent,
  HookEventName,
  HookHandler,
  HookHandlerContext,
  HookHandlerResult,
  HookMatcher,
  HookRunResult,
  HookRunner,
  HookScope
} from './types'
