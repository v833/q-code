/**
 * 交互 CLI 与无头 exec 共用的 ConversationRuntime 生命周期。
 *
 * Runtime 统一初始化、串行 turn、事件、取消与关闭；driver 封装具体模型和工具流水线。
 */
import { randomUUID } from 'node:crypto'
import type { ImageAttachment } from '../attachments'
import type {
  ConversationEvent,
  ConversationEventListener,
  ConversationUsage,
} from './conversation-events'

/** 单轮输入。 */
export interface ConversationTurnInput {
  prompt: string
  imageAttachments?: ImageAttachment[]
  modelName?: string
  allowedToolNames?: Set<string>
  /** 无头调用需要最终文本；交互 tool-only 轮次可设为 false。 */
  requireFinalText?: boolean
}

/** 单轮完成结果。 */
export interface ConversationTurnResult {
  finalText: string
  usage: ConversationUsage
}

/** ConversationRuntime 对底层执行流水线的依赖。 */
export interface ConversationRuntimeDriver {
  initialize(): Promise<void>
  executeTurn(input: ConversationTurnInput): Promise<ConversationTurnResult>
  switchSession?(sessionId: string): Promise<void>
  abort(reason?: unknown): void
  close(): Promise<void>
  getSessionId(): string
}

/** ConversationRuntime 构造选项。 */
export interface ConversationRuntimeOptions {
  driver: ConversationRuntimeDriver
  onEvent?: ConversationEventListener
}

/** 共享会话 Runtime。 */
export interface ConversationRuntime {
  initialize(): Promise<void>
  runTurn(input: ConversationTurnInput): Promise<ConversationTurnResult>
  switchSession(sessionId: string): Promise<void>
  abort(reason?: unknown): void
  close(): Promise<void>
  publish(event: ConversationEvent): void
}

/** 创建一个串行、可取消、可重复关闭的 ConversationRuntime。 */
export function createConversationRuntime(options: ConversationRuntimeOptions): ConversationRuntime {
  let initializePromise: Promise<void> | undefined
  let activeTurn = false
  let closed = false
  let announcedSessionId: string | undefined

  const publish = (event: ConversationEvent): void => {
    options.onEvent?.(event)
  }

  const announceSession = (): void => {
    const sessionId = options.driver.getSessionId()
    if (announcedSessionId === sessionId) return
    announcedSessionId = sessionId
    publish({ type: 'session_started', sessionId })
  }

  const initialize = async (): Promise<void> => {
    if (closed) throw new Error('ConversationRuntime 已关闭')
    if (!initializePromise) {
      initializePromise = options.driver.initialize().then(() => {
        announceSession()
      })
    }
    return initializePromise
  }

  return {
    initialize,
    async runTurn(input): Promise<ConversationTurnResult> {
      if (activeTurn) throw new Error('ConversationRuntime 同时只能执行一个 turn')
      activeTurn = true
      let turnStarted = false
      try {
        await initialize()
        publish({ type: 'turn_started' })
        turnStarted = true
        const result = await options.driver.executeTurn(input)
        if (!result.finalText.trim() && input.requireFinalText !== false) {
          throw new Error('Agent 未返回最终文本')
        }
        if (result.finalText.trim()) {
          publish({
            type: 'assistant_completed',
            messageId: randomUUID(),
            text: result.finalText,
          })
        }
        publish({ type: 'turn_completed', usage: result.usage })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        publish(turnStarted
          ? { type: 'turn_failed', message }
          : { type: 'runtime_error', message })
        throw error
      } finally {
        activeTurn = false
      }
    },
    async switchSession(sessionId): Promise<void> {
      if (closed) throw new Error('ConversationRuntime 已关闭')
      if (activeTurn) throw new Error('turn 执行期间不能切换会话')
      if (!options.driver.switchSession) throw new Error('当前 Runtime 不支持切换会话')
      await initialize()
      await options.driver.switchSession(sessionId)
      announceSession()
    },
    abort(reason): void {
      options.driver.abort(reason)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      options.driver.abort(new Error('ConversationRuntime 正在关闭'))
      await options.driver.close()
    },
    publish,
  }
}
