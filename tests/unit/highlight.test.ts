import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_HIGHLIGHT_CODE_BYTES,
  highlightCode,
  resolveAutoHighlightThemeMode
} from '../../src/terminal/utils/highlight'

const TEST_ENV_KEYS = ['NO_COLOR', 'Q_CODE_THEME', 'COLORFGBG', 'TERM_PROGRAM'] as const
const savedEnv = new Map<string, string | undefined>()

describe('terminal code highlighting', () => {
  beforeEach(() => {
    for (const key of TEST_ENV_KEYS) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of TEST_ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv.clear()
  })

  it('switches themes and keeps at least four colored token groups in ts code', () => {
    const code = ['const value = 42', '// comment', 'console.log("hi")'].join('\n')

    process.env.Q_CODE_THEME = 'dark'
    const dark = highlightCode(code, 'ts')

    process.env.Q_CODE_THEME = 'light'
    const light = highlightCode(code, 'ts')

    expect(dark).not.toBe(code)
    expect(light).not.toBe(code)
    expect(dark).not.toBe(light)

    const ansiGroups = new Set(dark.match(/\x1b\[[0-9;]+m/g) ?? [])
    expect(ansiGroups.size).toBeGreaterThanOrEqual(4)
  })

  it('infers light and dark themes from COLORFGBG', () => {
    expect(resolveAutoHighlightThemeMode({ COLORFGBG: '0;15' })).toBe('light')
    expect(resolveAutoHighlightThemeMode({ COLORFGBG: '0;0' })).toBe('dark')
  })

  it('disables ANSI output when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1'

    const code = ['const value = 42', '// comment'].join('\n')
    const highlighted = highlightCode(code, 'ts')

    expect(highlighted).toBe(code)
    expect(highlighted).not.toContain('\x1b[')
  })

  it('falls back to plain green when the code block is too large', () => {
    const code = 'x'.repeat(MAX_HIGHLIGHT_CODE_BYTES + 1)
    const highlighted = highlightCode(code, 'ts')

    expect(highlighted).toContain(code)
    expect(highlighted.startsWith('\x1b[32m')).toBe(true)
    expect(highlighted.endsWith('\x1b[0m')).toBe(true)
  })

  it('renders diff blocks with line-level colors', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,3 @@',
      '-const oldValue = 1',
      '+const newValue = 2',
      ' console.log(newValue)',
      '\\ No newline at end of file'
    ].join('\n')

    const highlighted = highlightCode(diff, 'diff')

    expect(highlighted).toContain('\x1b[90mdiff --git a/src/app.ts b/src/app.ts\x1b[0m')
    expect(highlighted).toContain('\x1b[90mindex 1111111..2222222 100644\x1b[0m')
    expect(highlighted).toContain('\x1b[90m--- a/src/app.ts\x1b[0m')
    expect(highlighted).toContain('\x1b[90m+++ b/src/app.ts\x1b[0m')
    expect(highlighted).toContain('\x1b[36m@@ -1,3 +1,3 @@\x1b[0m')
    expect(highlighted).toContain('\x1b[31m-const oldValue = 1\x1b[0m')
    expect(highlighted).toContain('\x1b[32m+const newValue = 2\x1b[0m')
    expect(highlighted).toContain('\x1b[90m\\ No newline at end of file\x1b[0m')
  })
})
