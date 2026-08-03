/**
 * 共享 ConversationRuntime 的界面无关事件契约。
 *
 * TUI、classic 与 Codex JSONL 适配层消费同一组事件，核心运行时不依赖展示协议。
 */

/** 单轮累计 token 用量。 */
export interface ConversationUsage {
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
}

/** ConversationRuntime 向适配层发布的中立事件。 */
export type ConversationEvent =
  | { type: 'session_started'; sessionId: string }
  | { type: 'turn_started' }
  | {
      type: 'tool_started'
      toolCallId: string
      name: string
      input?: unknown
    }
  | {
      type: 'tool_completed'
      toolCallId: string
      name: string
      input?: unknown
      output: unknown
      isError: boolean
    }
  | {
      type: 'assistant_completed'
      messageId: string
      text: string
    }
  | { type: 'turn_completed'; usage: ConversationUsage }
  | { type: 'turn_failed'; message: string }
  | { type: 'runtime_error'; message: string }

/** Runtime 事件订阅函数。 */
export type ConversationEventListener = (event: ConversationEvent) => void
