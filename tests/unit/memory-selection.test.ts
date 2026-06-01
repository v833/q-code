import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSelectedMemoryContext,
  MEMORY_INJECT_MAX_FILE_BYTES,
  MEMORY_INJECT_MAX_SESSION_BYTES,
  selectRelevantMemories,
  waitForMemorySelectionResult,
  type MemorySelectionResult,
  type MemorySessionBudget
} from '../../src/context/memory/selection'
import { writeProjectMemory } from '../../src/context/memory/memdir'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

describe('memory selection and injection', () => {
  let home: TempHome | undefined

  afterEach(() => {
    home?.dispose()
    home = undefined
  })

  it('selects at most five relevant memory headers and never reads bodies for scoring', async () => {
    home = setupTempHome('memory-select-')
    for (let i = 0; i < 7; i += 1) {
      await writeProjectMemory({
        cwd: home.cwd,
        name: `pnpm 测试约定 ${i}`,
        description: `和 pnpm vitest 测试相关 ${i}`,
        type: 'feedback',
        content: `body ${i}`,
        fileName: `testing-${i}.md`
      })
    }
    await writeProjectMemory({
      cwd: home.cwd,
      name: '部署规则',
      description: '生产发布窗口',
      type: 'project',
      content: 'deploy body',
      fileName: 'deploy.md'
    })

    const result = await selectRelevantMemories({ cwd: home.cwd, userQuery: '怎么跑 pnpm vitest 测试' })

    expect(result.candidateCount).toBe(8)
    expect(result.selected).toHaveLength(5)
    expect(result.selected.every((item) => item.relativePath.startsWith('testing-'))).toBe(true)
  })

  it('formats selected body with age hints and file/session budgets', async () => {
    home = setupTempHome('memory-inject-')
    await writeProjectMemory({
      cwd: home.cwd,
      name: '项目规范',
      description: '包管理和测试约定',
      type: 'feedback',
      content: 'a'.repeat(MEMORY_INJECT_MAX_FILE_BYTES + 500),
      fileName: 'project-rules.md'
    })
    const budget: MemorySessionBudget = { injectedBytes: 0 }

    const injected = await buildSelectedMemoryContext({
      cwd: home.cwd,
      selected: [{ relativePath: 'project-rules.md', reason: '当前请求涉及测试', confidence: 0.9 }],
      sessionBudget: budget,
      now: new Date(Date.now() + 3 * 86_400_000)
    })

    expect(injected.context).toContain('[q_code_memory_context]')
    expect(injected.context).toContain('Selected because: 当前请求涉及测试')
    expect(injected.context).toContain('Note: 这是 3 天前的快照')
    expect(injected.truncated).toBe(true)
    expect(budget.injectedBytes).toBeLessThanOrEqual(MEMORY_INJECT_MAX_FILE_BYTES)

    const exhausted = await buildSelectedMemoryContext({
      cwd: home.cwd,
      selected: [{ relativePath: 'project-rules.md', reason: 'again', confidence: 0.9 }],
      sessionBudget: { injectedBytes: MEMORY_INJECT_MAX_SESSION_BYTES }
    })
    expect(exhausted.context).toBeNull()
    expect(exhausted.skippedBySessionBudget).toBe(true)
  })

  it('enforces UTF-8 byte budgets for multibyte memory bodies', async () => {
    home = setupTempHome('memory-byte-budget-')
    await writeProjectMemory({
      cwd: home.cwd,
      name: '中文预算',
      description: '多字节正文',
      type: 'project',
      content: '汉'.repeat(MEMORY_INJECT_MAX_FILE_BYTES),
      fileName: 'unicode.md'
    })

    const injected = await buildSelectedMemoryContext({
      cwd: home.cwd,
      selected: [{ relativePath: 'unicode.md', reason: '预算测试', confidence: 0.9 }],
      sessionBudget: { injectedBytes: 0 }
    })

    expect(injected.items[0]?.bytes).toBeLessThanOrEqual(MEMORY_INJECT_MAX_FILE_BYTES)
    expect(injected.truncated).toBe(true)
  })

  it('skips selection when user asks to ignore memory', async () => {
    home = setupTempHome('memory-ignore-')
    await writeProjectMemory({
      cwd: home.cwd,
      name: '测试约定',
      description: 'pnpm',
      type: 'feedback',
      content: 'body',
      fileName: 'testing.md'
    })

    const result = await selectRelevantMemories({ cwd: home.cwd, userQuery: '忽略记忆，告诉我测试命令' })

    expect(result.ignored).toBe(true)
    expect(result.selected).toEqual([])
  })

  it('waits briefly for async selector results instead of dropping them immediately', async () => {
    const resultPromise = new Promise<MemorySelectionResult>((resolve) => {
      setTimeout(() => resolve({
        ignored: false,
        candidateCount: 1,
        selected: [{ relativePath: 'testing.md', reason: 'match', confidence: 0.8 }],
        elapsedMs: 10
      }), 10)
    })

    await expect(waitForMemorySelectionResult({ promise: resultPromise }, 50)).resolves.toMatchObject({
      candidateCount: 1,
      selected: [{ relativePath: 'testing.md' }]
    })
  })
})
