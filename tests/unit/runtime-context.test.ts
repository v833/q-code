import { describe, expect, it } from 'vitest'
import { formatRuntimeEnvironmentContext, type RuntimeEnvironmentContext } from '../../src/context/runtime-context'

describe('runtime context formatting', () => {
  it('uses day-level dates instead of second-level timestamps', () => {
    const text = formatRuntimeEnvironmentContext({
      cwd: '/repo',
      date: '2026-05-29',
      os: 'darwin test'
    })

    expect(text).toContain('- 当前日期: 2026-05-29')
    expect(text).not.toContain('T09:')
  })

  it('summarizes dirty git state without embedding full status output', () => {
    const context: RuntimeEnvironmentContext = {
      cwd: '/repo',
      date: '2026-05-29',
      os: 'darwin test',
      gitBranch: 'main',
      gitStatus: 'dirty',
      gitChangedFiles: 3,
      gitRecentCommit: 'abc123 feat: demo'
    }

    const text = formatRuntimeEnvironmentContext(context)

    expect(text).toContain('- Git 状态: dirty (3 changed files)')
    expect(text).not.toContain(' M src/')
  })
})
