import { describe, expect, it } from 'vitest'
import {
  detectPromptCursorMode,
  isIntegratedIdeTerminal,
  parsePromptCursorMode
} from '../../src/terminal/cursor-mode'

describe('prompt cursor mode', () => {
  it('parses explicit cursor mode overrides', () => {
    expect(parsePromptCursorMode('ansi')).toBe('ansi')
    expect(parsePromptCursorMode('native')).toBe('ansi')
    expect(parsePromptCursorMode('inline')).toBe('inline')
    expect(parsePromptCursorMode('block')).toBe('inline')
    expect(parsePromptCursorMode('off')).toBe('off')
    expect(parsePromptCursorMode('auto')).toBe('auto')
    expect(parsePromptCursorMode('weird')).toBeUndefined()
  })

  it('defaults IDE integrated terminals to inline cursor', () => {
    expect(detectPromptCursorMode({ env: { TERM_PROGRAM: 'vscode' } })).toBe('inline')
    expect(detectPromptCursorMode({ env: { TERM_PROGRAM: 'cursor' } })).toBe('inline')
    expect(detectPromptCursorMode({ env: { TERM_PROGRAM: 'windsurf' } })).toBe('inline')
    expect(detectPromptCursorMode({ env: { TERM_PROGRAM: 'trae' } })).toBe('inline')
    expect(detectPromptCursorMode({ env: { TERMINAL_EMULATOR: 'JetBrains-JediTerm' } })).toBe(
      'inline'
    )
  })

  it('keeps plain terminals on ansi cursor by default', () => {
    expect(detectPromptCursorMode({ env: { TERM_PROGRAM: 'Windows_Terminal' } })).toBe('ansi')
    expect(detectPromptCursorMode({ env: {} })).toBe('ansi')
  })

  it('lets env override auto detection', () => {
    expect(
      detectPromptCursorMode({
        env: { TERM_PROGRAM: 'vscode', Q_CODE_TUI_CURSOR: 'ansi' }
      })
    ).toBe('ansi')
    expect(
      detectPromptCursorMode({
        env: { Q_CODE_TUI_CURSOR: 'inline' }
      })
    ).toBe('inline')
    expect(
      detectPromptCursorMode({
        env: { Q_CODE_TUI_CURSOR: 'off' }
      })
    ).toBe('off')
  })

  it('detects common IDE environment markers', () => {
    expect(isIntegratedIdeTerminal({ TERM_PROGRAM: 'vscode', VSCODE_PID: '123' })).toBe(true)
    expect(isIntegratedIdeTerminal({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' })).toBe(true)
    expect(isIntegratedIdeTerminal({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false)
  })
})
