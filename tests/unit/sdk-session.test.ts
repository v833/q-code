import { beforeEach, describe, expect, it, vi } from 'vitest'

const runMainMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/cli/main', () => ({ runMain: runMainMock }))
vi.mock('../../src/config/runtime-config', () => ({ applyRuntimeConfig: vi.fn() }))
vi.mock('../../src/runtime/cli-info', () => ({ getPackageVersion: () => 'test-version' }))

import { createQCodeSession } from '../../src/sdk'

describe('SDK session', () => {
  beforeEach(() => {
    runMainMock.mockReset()
    runMainMock.mockImplementation(fakeRunMain())
  })

  it('exposes the session id and runs turns through runMain', async () => {
    const events: string[] = []
    const session = await createQCodeSession({
      cwd: process.cwd(),
      onEvent: (event) => events.push(event.type),
    })

    expect(session.sessionId).toBe('session-1')
    const result = await session.run('hello')

    expect(result).toEqual({
      sessionId: 'session-1',
      finalText: 'answer: hello',
      usage: { inputTokens: 1, outputTokens: 2 },
    })
    expect(events).toEqual(['turn_started'])
    await session.close()
  })

  it('rejects a second concurrent run', async () => {
    let release: (() => void) | undefined
    runMainMock.mockImplementation(fakeRunMain(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }))
    const session = await createQCodeSession({ cwd: process.cwd() })

    const first = session.run('first')
    await expect(session.run('second')).rejects.toThrow(/上一次 run/)
    release?.()
    await first
    await session.close()
  })

  it('rejects runs after close', async () => {
    const session = await createQCodeSession({ cwd: process.cwd() })

    await session.close()
    await session.close()

    await expect(session.run('after close')).rejects.toThrow(/已关闭/)
  })

  it('marks the session closed when a turn fails', async () => {
    runMainMock.mockImplementation(async ({ headless }: any) => {
      headless.onSessionReady?.('session-1')
      for await (const turn of headless.turns) {
        if (turn.prompt === 'boom') throw new Error('boom')
        headless.onTurnResult?.({
          sessionId: 'session-1',
          finalText: `answer: ${turn.prompt}`,
          usage: { inputTokens: 1, outputTokens: 2 },
        })
      }
    })
    const session = await createQCodeSession({ cwd: process.cwd() })

    await expect(session.run('boom')).rejects.toThrow('boom')
    await expect(session.run('next')).rejects.toThrow(/已关闭/)
  })
})

function fakeRunMain(onTurn?: () => Promise<void>) {
  return async ({ headless }: any): Promise<void> => {
    headless.onSessionReady?.('session-1')
    for await (const turn of headless.turns) {
      headless.onEvent?.({ type: 'turn_started' })
      await onTurn?.()
      headless.onTurnResult?.({
        sessionId: 'session-1',
        finalText: `answer: ${turn.prompt}`,
        usage: { inputTokens: 1, outputTokens: 2 },
      })
    }
  }
}
