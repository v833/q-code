import { describe, expect, it } from 'vitest'
import { AcpArgsError, formatAcpHelp, parseAcpArgs } from '../../src/cli/acp-args'

describe('ACP args', () => {
  it('parses workspace and utility actions', () => {
    expect(parseAcpArgs(['--cd', 'C:/workspace'])).toEqual({
      action: 'run',
      cwd: 'C:/workspace'
    })
    expect(parseAcpArgs(['--cd=C:/workspace'])).toEqual({
      action: 'run',
      cwd: 'C:/workspace'
    })
    expect(parseAcpArgs(['--help'])).toEqual({ action: 'help' })
    expect(parseAcpArgs(['-V'])).toEqual({ action: 'version' })
  })

  it('rejects unsupported options', () => {
    expect(() => parseAcpArgs(['--json'])).toThrow(AcpArgsError)
    expect(() => parseAcpArgs(['--cd'])).toThrow(/需要一个工作目录/)
  })

  it('documents the stdio contract in help', () => {
    expect(formatAcpHelp('1.2.3')).toContain('newline-delimited JSON-RPC')
    expect(formatAcpHelp('1.2.3')).toContain('q-code acp [OPTIONS]')
  })
})
