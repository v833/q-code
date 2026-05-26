/**
 * Hook 事件工厂：构造带 session/cwd/agent 时间戳的标准事件对象。
 */
import type {
  HookAgentContext,
  HookBaseEvent,
  HookEvent,
  HookPreToolUseEvent,
  HookPostToolUseEvent
} from './types'

/** 创建 Hook 事件时的最小上下文。 */
export interface HookEventFactoryContext {
  sessionId: string
  cwd: string
  agent?: HookAgentContext
}

/** 生成各事件共享的基础字段（不含 discriminant `event`）。 */
export function baseHookEvent(context: HookEventFactoryContext): Omit<HookBaseEvent, 'event'> {
  return {
    sessionId: context.sessionId,
    cwd: context.cwd,
    timestamp: new Date().toISOString(),
    agent: context.agent ?? { kind: 'main' }
  }
}

/** 根据载荷创建完整 Hook 事件（会话/子 Agent 等）。 */
export function createHookEvent(
  context: HookEventFactoryContext,
  event: HookEventPayload
): HookEvent {
  return {
    ...baseHookEvent(context),
    ...event
  } as HookEvent
}

type HookEventPayload =
  | { event: 'session_start' }
  | { event: 'session_end'; reason?: string }
  | { event: 'user_prompt_submit'; prompt: string }
  | { event: 'stop'; reason?: string }
  | {
      event: 'subagent_start'
      subagent: {
        agentType: string
        prompt: string
        description?: string
      }
    }
  | {
      event: 'subagent_stop'
      subagent: {
        agentType: string
        finalText?: string
        reason?: string
      }
    }

/** 创建 `pre_tool_use` 事件，供 ToolRegistry 在工具执行前触发。 */
export function createPreToolUseEvent(
  context: HookEventFactoryContext,
  tool: HookPreToolUseEvent['tool']
): HookPreToolUseEvent {
  return {
    ...baseHookEvent(context),
    event: 'pre_tool_use',
    tool
  }
}

/** 创建 `post_tool_use` 事件，供 ToolRegistry 在工具执行后触发。 */
export function createPostToolUseEvent(
  context: HookEventFactoryContext,
  tool: HookPostToolUseEvent['tool']
): HookPostToolUseEvent {
  return {
    ...baseHookEvent(context),
    event: 'post_tool_use',
    tool
  }
}
