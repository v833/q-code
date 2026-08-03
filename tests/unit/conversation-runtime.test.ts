import { describe, expect, it } from 'vitest'
import {
  createConversationRuntime,
  type ConversationRuntimeDriver,
} from '../../src/cli/conversation-runtime'
import type { ConversationEvent } from '../../src/cli/conversation-events'

describe('ConversationRuntime', () => {
  it('initializes once and emits a complete successful turn', async () => {
    const calls: string[] = []
    const events: ConversationEvent[] = []
    const runtime = createConversationRuntime({
      driver: makeDriver(calls),
      onEvent: (event) => events.push(event),
    })

    await runtime.initialize()
    const result = await runtime.runTurn({ prompt: 'hello' })

    expect(result.finalText).toBe('answer: hello')
    expect(calls).toEqual(['initialize', 'turn:hello'])
    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'turn_started',
      'assistant_completed',
      'turn_completed',
    ])
  })

  it('rejects concurrent turns and emits a failed event', async () => {
    let release: (() => void) | undefined
    const events: ConversationEvent[] = []
    const driver = makeDriver([])
    driver.executeTurn = async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { finalText: 'done', usage: { inputTokens: 0, outputTokens: 0 } }
    }
    const runtime = createConversationRuntime({ driver, onEvent: (event) => events.push(event) })

    const first = runtime.runTurn({ prompt: 'first' })
    await expect(runtime.runTurn({ prompt: 'second' })).rejects.toThrow(/一个 turn/)
    release?.()
    await first

    driver.executeTurn = async () => {
      throw new Error('model failed')
    }
    await expect(runtime.runTurn({ prompt: 'third' })).rejects.toThrow('model failed')
    expect(events.at(-1)).toEqual({ type: 'turn_failed', message: 'model failed' })
  })

  it('emits runtime_error when initialization fails before a turn starts', async () => {
    const driver = makeDriver([])
    driver.initialize = async () => {
      throw new Error('startup failed')
    }
    const events: ConversationEvent[] = []
    const runtime = createConversationRuntime({ driver, onEvent: (event) => events.push(event) })

    await expect(runtime.runTurn({ prompt: 'hello' })).rejects.toThrow('startup failed')
    expect(events).toEqual([{ type: 'runtime_error', message: 'startup failed' }])
    await runtime.close()
  })

  it('switches sessions and closes idempotently', async () => {
    const calls: string[] = []
    let sessionId = 'session-1'
    const driver = makeDriver(calls)
    driver.getSessionId = () => sessionId
    driver.switchSession = async (next) => {
      calls.push(`switch:${next}`)
      sessionId = next
    }
    const events: ConversationEvent[] = []
    const runtime = createConversationRuntime({ driver, onEvent: (event) => events.push(event) })

    await runtime.switchSession('session-2')
    await runtime.close()
    await runtime.close()

    expect(calls).toEqual(['initialize', 'switch:session-2', 'abort', 'close'])
    expect(events.filter((event) => event.type === 'session_started')).toEqual([
      { type: 'session_started', sessionId: 'session-1' },
      { type: 'session_started', sessionId: 'session-2' },
    ])
  })
})

function makeDriver(calls: string[]): ConversationRuntimeDriver {
  return {
    async initialize() {
      calls.push('initialize')
    },
    async executeTurn(input) {
      calls.push(`turn:${input.prompt}`)
      return {
        finalText: `answer: ${input.prompt}`,
        usage: { inputTokens: 1, outputTokens: 2 },
      }
    },
    abort() {
      calls.push('abort')
    },
    async close() {
      calls.push('close')
    },
    getSessionId() {
      return 'session-1'
    },
  }
}
