import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSelectedMemoryContext,
  MEMORY_INJECT_MAX_FILE_CHARS,
  MEMORY_INJECT_MAX_SESSION_CHARS,
  selectRelevantMemories,
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
      content: 'a'.repeat(MEMORY_INJECT_MAX_FILE_CHARS + 500),
      fileName: 'project-rules.md'
    })
    const budget: MemorySessionBudget = { injectedChars: 0 }

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
    expect(budget.injectedChars).toBeLessThanOrEqual(MEMORY_INJECT_MAX_FILE_CHARS)

    const exhausted = await buildSelectedMemoryContext({
      cwd: home.cwd,
      selected: [{ relativePath: 'project-rules.md', reason: 'again', confidence: 0.9 }],
      sessionBudget: { injectedChars: MEMORY_INJECT_MAX_SESSION_CHARS }
    })
    expect(exhausted.context).toBeNull()
    expect(exhausted.skippedBySessionBudget).toBe(true)
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
})
