import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { describe, expect, it } from 'vitest'
import {
  formatCliHelp,
  formatCliVersion,
  formatExecHelp,
  getEarlyCliCommand,
  isDebugMode
} from '../../src/runtime/cli-info'
import { getStringArg } from '../../src/runtime/cli-utils'
import { createStartupTrace, isStartupTraceEnabled } from '../../src/runtime/startup-trace'

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

  it('detects dashboard command', () => {
    expect(getEarlyCliCommand(['dashboard'])).toBe('dashboard')
    expect(getEarlyCliCommand(['dashboard', '--port', '0'])).toBe('dashboard')
  })

  it('routes exec before nested help flags', () => {
    expect(getEarlyCliCommand(['exec', '--json', 'prompt'])).toBe('exec')
    expect(getEarlyCliCommand(['exec', '--help'])).toBe('exec')
    expect(getEarlyCliCommand(['exec', 'resume', '--help'])).toBe('exec')
  })

  it('leaves interactive flags alone', () => {
    expect(getEarlyCliCommand(['--continue'])).toBeUndefined()
    expect(getEarlyCliCommand(['--session', 'demo'])).toBeUndefined()
    expect(getEarlyCliCommand(['--debug'])).toBeUndefined()
  })

  it('parses string flags from the provided argv slice', () => {
    expect(getStringArg('--session', ['--session', 'demo'])).toBe('demo')
    expect(getStringArg('--session', ['--session=demo'])).toBe('demo')
    expect(getStringArg('--session', ['--session', '--plan'])).toBeUndefined()
  })

  it('detects debug mode from cli flag or env', () => {
    expect(isDebugMode(['--debug'], {})).toBe(true)
    expect(isDebugMode([], { Q_CODE_DEBUG: '1' })).toBe(true)
    expect(isDebugMode([], { Q_CODE_DEBUG: 'true' })).toBe(true)
    expect(isDebugMode([], { Q_CODE_DEBUG: '0' })).toBe(false)
    expect(isDebugMode([], {})).toBe(false)
  })

  it('detects startup trace from debug or env', () => {
    expect(isStartupTraceEnabled(['--debug'], {})).toBe(true)
    expect(isStartupTraceEnabled([], { Q_CODE_STARTUP_TRACE: 'true' })).toBe(true)
    expect(isStartupTraceEnabled([], { Q_CODE_STARTUP_TRACE: '0' })).toBe(false)
    expect(isStartupTraceEnabled([], {})).toBe(false)
  })

  it('records startup trace marks only when enabled', () => {
    let now = 100
    const trace = createStartupTrace({
      enabled: true,
      now: () => now
    })

    now += 12
    trace.mark('bootstrap')
    now += 5
    trace.mark('main-import')

    expect(trace.entries()).toEqual([
      { name: 'bootstrap', elapsedMs: 12 },
      { name: 'main-import', elapsedMs: 5 }
    ])
    const lines: string[] = []
    trace.print((line) => lines.push(line))
    expect(lines.join('\n')).toContain('[Startup] bootstrap')

    const disabled = createStartupTrace({ enabled: false, now: () => 1 })
    disabled.mark('ignored')
    expect(disabled.entries()).toEqual([])
  })

  it('keeps the published bootstrap entry free of heavy static imports', () => {
    const bootstrap = readFileSync(new URL('../../src/cli/bootstrap.ts', import.meta.url), 'utf-8')

    expect(bootstrap).not.toContain("from '../terminal/runtime'")
    expect(bootstrap).not.toContain("from '../evals'")
    expect(bootstrap).not.toContain("from '../config/runtime-config'")
    expect(bootstrap).not.toContain("from '../observability/audit-cli'")
    expect(bootstrap).not.toContain("from '../dashboard'")
    expect(bootstrap).not.toContain("from 'dotenv'")
    expect(bootstrap).not.toContain("from 'ai'")
    expect(bootstrap).not.toContain("from '@ai-sdk/openai'")
    expect(bootstrap).toContain("await import('./main')")
    expect(bootstrap).toContain("await import('./exec-cli')")
    expect(bootstrap).toContain("await import('../evals')")
    expect(bootstrap).toContain("await import('../dashboard')")
  })

  it('keeps the published build split so dynamic imports stay lazy', () => {
    const buildScript = readFileSync(new URL('../../scripts/build.mjs', import.meta.url), 'utf-8')

    expect(buildScript).toContain("entryPoints: ['src/cli/bootstrap.ts']")
    expect(buildScript).toContain("outdir: 'dist'")
    expect(buildScript).toContain('splitting: true')
    expect(buildScript).not.toContain("outfile: 'dist/index.js'")
  })

  it('keeps the built entry free of heavy early-path imports', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const outdir = mkdtempSync(join(tmpdir(), 'q-code-bootstrap-build-'))

    try {
      await esbuild({
        absWorkingDir: root,
        entryPoints: ['src/cli/bootstrap.ts'],
        outdir,
        bundle: true,
        splitting: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        packages: 'external',
        entryNames: 'index',
        chunkNames: 'chunks/[name]-[hash]',
      })

      const distEntry = readFileSync(join(outdir, 'index.js'), 'utf-8')
      expect(distEntry).not.toContain('from "ink"')
      expect(distEntry).not.toContain('from "react"')
      expect(distEntry).not.toContain('@ai-sdk/openai')
      expect(distEntry).not.toContain('@modelcontextprotocol/sdk')
      expect(distEntry).not.toContain('@langfuse/')
      expect(distEntry).toContain("await import(\"./chunks/main-")
    } finally {
      rmSync(outdir, { recursive: true, force: true })
    }
  })

  it('keeps Ink behind the TUI-only dynamic import in main runtime', () => {
    const main = readFileSync(new URL('../../src/cli/main.ts', import.meta.url), 'utf-8')

    expect(main).not.toContain("from '../terminal/runtime'")
    expect(main).not.toContain("from 'ink'")
    expect(main).not.toContain("from 'react'")
    expect(main).toContain("await import('../terminal/runtime')")
  })

  it('keeps startup warmup behind an explicit ready gate', () => {
    const main = readFileSync(new URL('../../src/cli/main.ts', import.meta.url), 'utf-8')

    expect(main).toContain('const startupWarmupPromise = startStartupWarmup()')
    expect(main).toContain('async function finishStartupWarmup()')
    expect(main).toContain('const startupReadyGate = createStartupReadyGate()')
    expect(main).toContain('startupReadyGate.runInBackground')
    expect(main).toContain('await startupReadyGate.wait()')
    expect(main).toContain("startupTrace.mark('warmup-start')")
    expect(main).toContain("startupTrace.mark('warmup-ready')")
    expect(main).toContain("startupTrace.mark('startup-ready')")
  })

  it('keeps prompt cache verification available as an npm script', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
      scripts?: Record<string, string>
    }

    expect(pkg.scripts?.['prompt:cache:verify']).toBe('tsx src/scripts/verify-prompt-cache.ts')
    expect(pkg.scripts?.['prompt:quality:verify']).toBe('tsx src/scripts/verify-prompt-quality.ts')
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
    expect(help).toContain('q-code dashboard')
    expect(help).toContain('q-code eval run')
    expect(help).toContain('--max-cost-usd')
    expect(help).toContain('--allow-real-model')
    expect(help).toContain('q-code eval trend')
    expect(help).toContain('q-code exec')
    expect(help).toContain('--continue')
    expect(help).toContain('Shift+Tab')
    expect(help).toContain('--no-color')
    expect(help).toContain('--debug')
    expect(help).toContain('~/.q-code/config.toml')
  })

  it('formats exec and resume help', () => {
    expect(formatExecHelp('1.2.3')).toContain('q-code exec [OPTIONS] [PROMPT]')
    expect(formatExecHelp('1.2.3')).toContain('--sandbox <MODE>')
    expect(formatExecHelp('1.2.3', true)).toContain('q-code exec resume')
    expect(formatExecHelp('1.2.3', true)).toContain('--last')
  })
})
