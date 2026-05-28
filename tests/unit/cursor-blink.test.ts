import { describe, expect, it } from 'vitest'
import { getInlineCursorBlinkMs } from '../../src/terminal/components/InputPrompt'

describe('inline cursor blink ms', () => {
  it('defaults to 500 when unset', () => {
    expect(getInlineCursorBlinkMs({})).toBe(500)
  })

  it('returns 0 to disable blinking when <= 0', () => {
    expect(getInlineCursorBlinkMs({ Q_CODE_TUI_CURSOR_BLINK_MS: '0' })).toBe(0)
    expect(getInlineCursorBlinkMs({ Q_CODE_TUI_CURSOR_BLINK_MS: '-1' })).toBe(0)
  })

  it('clamps to [100, 10000] for positive numbers', () => {
    expect(getInlineCursorBlinkMs({ Q_CODE_TUI_CURSOR_BLINK_MS: '1' })).toBe(100)
    expect(getInlineCursorBlinkMs({ Q_CODE_TUI_CURSOR_BLINK_MS: '99' })).toBe(100)
    expect(getInlineCursorBlinkMs({ Q_CODE_TUI_CURSOR_BLINK_MS: '500' })).toBe(500)
    expect(getInlineCursorBlinkMs({ Q_CODE_TUI_CURSOR_BLINK_MS: '999999' })).toBe(10_000)
  })

  it('falls back to 500 on invalid value', () => {
    expect(getInlineCursorBlinkMs({ Q_CODE_TUI_CURSOR_BLINK_MS: 'abc' })).toBe(500)
  })
})

