import { describe, expect, it } from 'vitest'
import {
  formatCliHelp,
  formatCliVersion,
  getEarlyCliCommand,
  isDebugMode
} from '../../src/runtime/cli-info'

describe('cli info', () => {
  it('detects help flags and command aliases', () => {
    expect(getEarlyCliCommand(['--help'])).toBe('help')
    expect(getEarlyCliCommand(['-h'])).toBe('help')
    expect(getEarlyCliCommand(['help'])).toBe('help')
  })

  it('detects version flags and command aliases', () => {
    expect(getEarlyCliCommand(['--version'])).toBe('version')
    expect(getEarlyCliCommand(['-v'])).toBe('version')
    expect(getEarlyCliCommand(['version'])).toBe('version')
  })

  it('detects update command', () => {
    expect(getEarlyCliCommand(['update'])).toBe('update')
    expect(getEarlyCliCommand(['update', '--dry-run'])).toBe('update')
  })

  it('detects init command', () => {
    expect(getEarlyCliCommand(['init'])).toBe('init')
    expect(getEarlyCliCommand(['init', '--local'])).toBe('init')
  })

  it('detects eval command', () => {
    expect(getEarlyCliCommand(['eval'])).toBe('eval')
    expect(getEarlyCliCommand(['eval', 'run', 'evals/smoke'])).toBe('eval')
  })

  it('leaves interactive flags alone', () => {
    expect(getEarlyCliCommand(['--continue'])).toBeUndefined()
    expect(getEarlyCliCommand(['--session', 'demo'])).toBeUndefined()
    expect(getEarlyCliCommand(['--debug'])).toBeUndefined()
  })

  it('detects debug mode from cli flag or env', () => {
    expect(isDebugMode(['--debug'], {})).toBe(true)
    expect(isDebugMode([], { Q_CODE_DEBUG: '1' })).toBe(true)
    expect(isDebugMode([], { Q_CODE_DEBUG: 'true' })).toBe(true)
    expect(isDebugMode([], { Q_CODE_DEBUG: '0' })).toBe(false)
    expect(isDebugMode([], {})).toBe(false)
  })

  it('formats version output', () => {
    expect(formatCliVersion('1.2.3')).toBe('q-code 1.2.3')
  })

  it('formats help with common options', () => {
    const help = formatCliHelp('1.2.3')

    expect(help).toContain('q-code 1.2.3')
    expect(help).toContain('Usage:')
    expect(help).toContain('-h, --help')
    expect(help).toContain('-v, --version')
    expect(help).toContain('q-code update')
    expect(help).toContain('q-code init')
    expect(help).toContain('q-code eval run')
    expect(help).toContain('--max-cost-usd')
    expect(help).toContain('--allow-real-model')
    expect(help).toContain('q-code eval trend')
    expect(help).toContain('--continue')
    expect(help).toContain('Shift+Tab')
    expect(help).toContain('--no-color')
    expect(help).toContain('--debug')
    expect(help).toContain('~/.q-code/config.toml')
  })
})
