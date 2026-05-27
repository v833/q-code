import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHistoryStore } from '../../src/terminal/history-store'
import {
  createInputState,
  insertText,
  recallPrevious,
  submitInput
} from '../../src/terminal/input'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('persistent input history flow', () => {
  it('recalls the last submitted prompt after recreating the TUI input state', async () => {
    const { cwd, home } = createRoots()
    const firstStore = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 'session-a',
      env: { Q_CODE_HISTORY_SCOPE: 'project' }
    })

    const firstSubmit = submitInput(insertText(createInputState(), 'pnpm test'), {
      shouldRecord: (input) => firstStore.shouldRecord(input),
      maxHistory: firstStore.getRuntimeLimit()
    })
    await firstStore.append(firstSubmit.input)

    const secondStore = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 'session-b',
      env: { Q_CODE_HISTORY_SCOPE: 'project' }
    })
    const restored = createInputState(await secondStore.load())

    expect(recallPrevious(restored).value).toBe('pnpm test')
  })

  it('does not restore leading-space or sensitive prompts', async () => {
    const { cwd, home } = createRoots()
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 'session-a',
      env: { Q_CODE_HISTORY_SCOPE: 'project' }
    })

    for (const value of [' secret stuff', 'token=xxx', 'keep me']) {
      const submitted = submitInput(insertText(createInputState(), value), {
        shouldRecord: (input) => store.shouldRecord(input),
        maxHistory: store.getRuntimeLimit()
      })
      await store.append(submitted.input)
    }

    expect(await store.load()).toEqual(['keep me'])
  })
})

function createRoots(): { cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'q-code-history-flow-'))
  roots.push(root)
  const cwd = join(root, 'repo')
  const home = join(root, 'home')
  return { cwd, home }
}
