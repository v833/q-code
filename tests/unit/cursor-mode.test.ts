import { describe, expect, it } from 'vitest'
import {
  detectPromptCursorModeDecision,
  detectPromptCursorMode,
  isIntegratedIdeTerminal,
  parsePromptCursorMode
} from '../../src/terminal/cursor-mode'
import { detectTerminalCapabilities } from '../../src/terminal/terminal-capabilities'

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
    expect(detectPromptCursorMode({ env: { WT_SESSION: '1' }, platform: 'win32' })).toBe('ansi')
    expect(detectPromptCursorMode({ env: { MSYSTEM: 'MINGW64' }, platform: 'win32' })).toBe(
      'ansi'
    )
    expect(detectPromptCursorMode({ env: { TERM_PROGRAM: 'iTerm.app' }, platform: 'darwin' })).toBe(
      'ansi'
    )
    expect(detectPromptCursorMode({ env: { TERM_PROGRAM: 'WezTerm' }, platform: 'linux' })).toBe(
      'ansi'
    )
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
    expect(isIntegratedIdeTerminal({ CURSOR_TRACE_ID: 'trace' })).toBe(true)
    expect(isIntegratedIdeTerminal({ WINDSURF_BIN: '/usr/bin/windsurf' })).toBe(true)
    expect(isIntegratedIdeTerminal({ TRAE_IDE: '1' })).toBe(true)
    expect(isIntegratedIdeTerminal({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false)
  })

  it('returns a debuggable cursor mode decision', () => {
    const decision = detectPromptCursorModeDecision({
      env: { TERM_PROGRAM: 'vscode', VSCODE_PID: '123' },
      platform: 'win32'
    })

    expect(decision).toMatchObject({
      mode: 'inline',
      source: 'auto',
      capabilities: {
        hostKind: 'vscode-compatible',
        emulatorKind: 'xtermjs',
        platformKind: 'windows-conpty'
      }
    })
    expect(decision.reason).toContain('IDE integrated terminals avoid ANSI cursor chasing')
  })

  it('uses off mode for non-interactive terminals in auto mode', () => {
    expect(detectPromptCursorMode({ env: {}, isTTY: false })).toBe('off')
    expect(detectPromptCursorMode({ env: { CI: 'true' } })).toBe('off')
    expect(detectPromptCursorMode({ env: { CI: '1' } })).toBe('off')
    expect(detectPromptCursorMode({ env: { GITLAB_CI: 'true' } })).toBe('off')
    expect(detectPromptCursorMode({ env: { BUILDKITE: 'true' } })).toBe('off')
    expect(detectPromptCursorMode({ env: { TF_BUILD: 'true' } })).toBe('off')
  })

  it('uses inline mode for unknown Windows ConPTY hosts', () => {
    expect(detectPromptCursorMode({ env: {}, platform: 'win32' })).toBe('inline')
  })

  it('builds a terminal capability profile from environment fixtures', () => {
    expect(
      detectTerminalCapabilities({
        env: { TERM_PROGRAM: 'Windows_Terminal', WT_SESSION: 'abc' },
        platform: 'win32'
      })
    ).toMatchObject({
      hostKind: 'windows-terminal',
      emulatorKind: 'windows-terminal',
      platformKind: 'windows-conpty',
      riskFlags: []
    })
    expect(
      detectTerminalCapabilities({
        env: { MSYSTEM: 'MINGW64' },
        platform: 'win32'
      })
    ).toMatchObject({
      hostKind: 'git-bash',
      emulatorKind: 'mintty',
      platformKind: 'windows-conpty',
      riskFlags: []
    })
    expect(
      detectTerminalCapabilities({
        env: { TERMINAL_EMULATOR: 'JetBrains-JediTerm' },
        platform: 'darwin'
      })
    ).toMatchObject({
      hostKind: 'jetbrains',
      emulatorKind: 'jediterm',
      platformKind: 'unix',
      riskFlags: ['ide-integrated', 'cursor-sync-unstable', 'soft-wrap-sensitive']
    })
  })
})
