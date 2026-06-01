import { describe, expect, it } from 'vitest'
import {
  getInlineCursorBlinkMs,
  renderInputForCursorMode
} from '../../src/terminal/components/InputPrompt'

describe('inline cursor blink ms', () => {
  it('is disabled by default to avoid IDE terminal redraw jitter', () => {
    expect(getInlineCursorBlinkMs({})).toBeUndefined()
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

  it('keeps blinking disabled on invalid value', () => {
    expect(getInlineCursorBlinkMs({ Q_CODE_TUI_CURSOR_BLINK_MS: 'abc' })).toBeUndefined()
  })

  it('renders cursor text only for inline mode', () => {
    expect(
      renderInputForCursorMode({ value: '你a', cursor: 1, cursorMode: 'inline' })
    ).toBe('你█a')
    expect(renderInputForCursorMode({ value: '你a', cursor: 1, cursorMode: 'ansi' })).toBe('你a')
    expect(renderInputForCursorMode({ value: '你a', cursor: 1, cursorMode: 'off' })).toBe('你a')
  })
})
