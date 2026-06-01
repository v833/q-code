import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAgents } from '../../src/agents/registry'
import { runChildAgent } from '../../src/agents/run-agent'
import {
  DefaultHookRunner,
  createPreToolUseEvent,
  loadHookConfigs,
  matchesMatcher,
  type HookDefinition,
  type HookEvent
} from '../../src/hooks'
import { runCommandHookWithDependencies } from '../../src/hooks/command-runner'
import type { ShellInvocation } from '../../src/runtime/shell-invocation'
import { createMockModel } from '../_helpers/mock-model'

const tempDirs: string[] = []
const originalQCodeHome = process.env.Q_CODE_HOME
const originalSessionDir = process.env.Q_CODE_SESSION_DIR

afterEach(async () => {
  if (originalQCodeHome === undefined) delete process.env.Q_CODE_HOME
  else process.env.Q_CODE_HOME = originalQCodeHome
  if (originalSessionDir === undefined) delete process.env.Q_CODE_SESSION_DIR
  else process.env.Q_CODE_SESSION_DIR = originalSessionDir
  clearAgents()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function preTool(name: string, input: unknown = {}): HookEvent {
  return createPreToolUseEvent(
    {
      sessionId: 's1',
      cwd: process.cwd(),
      agent: { kind: 'main' }
    },
    { name, input, toolCallId: 'tc1' }
  )
}

describe('hooks matcher', () => {
  it('supports exact, wildcard and regex tool matching', () => {
    const event = preTool('read_file')
    expect(matchesMatcher({ tool: 'read_file' }, event)).toBe(true)
    expect(matchesMatcher({ tool: '*' }, event)).toBe(true)
    expect(matchesMatcher({ tool: '^read_' }, event)).toBe(true)
    expect(matchesMatcher({ tool: 'write_file' }, event)).toBe(false)
  })

  it('matches agent kind and event name', () => {
    const event = preTool('read_file')
    expect(matchesMatcher({ event: 'pre_tool_use', agentKind: 'main' }, event)).toBe(true)
    expect(matchesMatcher({ event: 'post_tool_use' }, event)).toBe(false)
    expect(matchesMatcher({ agentKind: 'subagent' }, event)).toBe(false)
  })
})

describe('DefaultHookRunner', () => {
  it('continues through non-matching hooks and records them', async () => {
    const runner = new DefaultHookRunner([
      {
        name: 'skip',
        type: 'handler',
        event: 'pre_tool_use',
        matcher: { tool: 'write_file' },
        scope: 'runtime',
        handler: () => ({ action: 'block', reason: 'nope' })
      }
    ])

    const result = await runner.run(preTool('read_file'))
    expect(result.blocked).toBe(false)
    expect(result.records).toMatchObject([{ matched: false, hookName: 'skip' }])
  })

  it('blocks when a matching blocking hook returns block', async () => {
    const runner = new DefaultHookRunner([
      {
        name: 'deny',
        type: 'handler',
        event: 'pre_tool_use',
        matcher: { tool: 'f' },
        scope: 'runtime',
        handler: () => ({ action: 'block', reason: 'dangerous command' })
      }
    ])

    const result = await runner.run(preTool('f', { command: 'rm -rf .' }))
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('dangerous command')
  })

  it('allows pre tool hooks to modify input', async () => {
    const runner = new DefaultHookRunner([
      {
        name: 'rewrite',
        type: 'handler',
        event: 'pre_tool_use',
        scope: 'runtime',
        handler: () => ({ action: 'modify', input: { value: 'rewritten' } })
      }
    ])

    const result = await runner.run(preTool('probe', { value: 'raw' }))
    expect(result.blocked).toBe(false)
    expect(result.input).toEqual({ value: 'rewritten' })
  })

  it('allows user_prompt_submit hooks to rewrite prompt and append context', async () => {
    const runner = new DefaultHookRunner([
      {
        name: 'inject',
        type: 'handler',
        event: 'user_prompt_submit',
        scope: 'runtime',
        handler: () => ({
          action: 'modify',
          prompt: 'rewritten prompt',
          appendContext: 'git: dirty',
          message: 'context injected'
        })
      },
      {
        name: 'append-more',
        type: 'handler',
        event: 'user_prompt_submit',
        scope: 'runtime',
        handler: () => ({ action: 'modify', appendContext: 'branch: main' })
      }
    ])

    const result = await runner.run({
      event: 'user_prompt_submit',
      sessionId: 's1',
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
      agent: { kind: 'main' },
      prompt: 'raw prompt'
    })

    expect(result.blocked).toBe(false)
    expect(result.prompt).toBe('rewritten prompt')
    expect(result.appendContext).toBe('git: dirty\n\nbranch: main')
    expect(result.warnings).toContain('context injected')
  })

  it('treats non-blocking hook errors as warnings', async () => {
    const runner = new DefaultHookRunner([
      {
        name: 'observer',
        type: 'handler',
        event: 'pre_tool_use',
        scope: 'runtime',
        blocking: false,
        handler: () => {
          throw new Error('observer failed')
        }
      }
    ])

    const result = await runner.run(preTool('read_file'))
    expect(result.blocked).toBe(false)
    expect(result.warnings[0]).toContain('observer failed')
  })

  it('subagent_stop sends preview and artifact metadata for long final output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'q-code-hooks-subagent-'))
    tempDirs.push(cwd)
    process.env.Q_CODE_SESSION_DIR = '.sessions'
    const finalText = `START\n${'Z'.repeat(9000)}\nEND`
    const { model } = createMockModel([{ text: finalText, finishReason: 'stop' }])
    let captured: HookEvent | undefined
    const runner = new DefaultHookRunner([
      {
        name: 'capture-subagent-stop',
        type: 'handler',
        event: 'subagent_stop',
        scope: 'runtime',
        handler: (event) => {
          captured = event
          return { action: 'continue' }
        }
      }
    ])

    await runChildAgent({
      agentDefinition: {
        agentType: 'Explore',
        whenToUse: 'test',
        source: 'built-in',
        getSystemPrompt: () => 'sys'
      },
      agentId: 'agent-1',
      prompt: 'run',
      availableTools: [],
      model,
      sessionId: 'session-1',
      cwdOverride: cwd,
      quiet: true,
      hooks: runner
    })

    expect(captured?.event).toBe('subagent_stop')
    const stop = captured as Extract<HookEvent, { event: 'subagent_stop' }>
    expect(stop.subagent.finalText).toBeUndefined()
    expect(stop.subagent.finalTextPreview).toContain('START')
    expect(stop.subagent.finalTextPreview).toContain('END')
    expect(stop.subagent.finalTextPreview).not.toContain('Z'.repeat(8000))
    expect(stop.subagent.resultTruncated).toBe(true)
    expect(stop.subagent.originalChars).toBe(finalText.length)
    expect(stop.subagent.artifactFile).toContain('agent-artifacts')
  })

  it('subagent_stop stores artifacts under artifactCwd when execution cwd differs', async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), 'q-code-hooks-project-'))
    const executionCwd = await mkdtemp(join(tmpdir(), 'q-code-hooks-worktree-'))
    tempDirs.push(projectCwd)
    tempDirs.push(executionCwd)
    process.env.Q_CODE_SESSION_DIR = '.sessions'
    const finalText = `START\n${'Z'.repeat(9000)}\nEND`
    const { model } = createMockModel([{ text: finalText, finishReason: 'stop' }])
    let captured: HookEvent | undefined
    const runner = new DefaultHookRunner([
      {
        name: 'capture-subagent-stop',
        type: 'handler',
        event: 'subagent_stop',
        scope: 'runtime',
        handler: (event) => {
          captured = event
          return { action: 'continue' }
        }
      }
    ])

    await runChildAgent({
      agentDefinition: {
        agentType: 'Explore',
        whenToUse: 'test',
        source: 'built-in',
        getSystemPrompt: () => 'sys'
      },
      agentId: 'agent-1',
      prompt: 'run',
      availableTools: [],
      model,
      sessionId: 'session-1',
      cwdOverride: executionCwd,
      artifactCwd: projectCwd,
      quiet: true,
      hooks: runner
    })

    const stop = captured as Extract<HookEvent, { event: 'subagent_stop' }>
    expect(stop.subagent.artifactFile).toContain(projectCwd)
    expect(stop.subagent.artifactFile).not.toContain(executionCwd)
  })
})

describe('hook config loader', () => {
  it('loads command hooks from project settings', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'q-code-hooks-'))
    const home = await mkdtemp(join(tmpdir(), 'q-code-hooks-home-'))
    tempDirs.push(cwd)
    tempDirs.push(home)
    process.env.Q_CODE_HOME = home
    const settingsDir = join(cwd, '.q-code')
    await mkdir(settingsDir, { recursive: true })
    await writeFile(
      join(settingsDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            pre_tool_use: [
              {
                name: 'deny-shell',
                matcher: { tool: 'f' },
                command: 'node .q-code/hooks/deny-shell.js',
                timeoutMs: 3000
              }
            ]
          }
        },
        null,
        2
      ),
      'utf-8'
    )

    const loaded = await loadHookConfigs(cwd)
    expect(loaded.errors).toEqual([])
    expect(loaded.hooks).toHaveLength(1)
    const hook = loaded.hooks[0] as Extract<HookDefinition, { type: 'command' }>
    expect(hook.name).toBe('deny-shell')
    expect(hook.event).toBe('pre_tool_use')
    expect(hook.scope).toBe('project')
  })
})

describe('command hook shell fallback', () => {
  const shells: ShellInvocation[] = [
    {
      command: 'pwsh',
      args: ['-Command', 'hook-command --secret token'],
      detached: false,
      unavailableMessage: '[PowerShell 不可用]'
    },
    {
      command: 'powershell.exe',
      args: ['-Command', 'hook-command --secret token'],
      detached: false,
      unavailableMessage: '[PowerShell 不可用]'
    }
  ]

  it('falls back to powershell.exe when pwsh spawn reports ENOENT', async () => {
    const spawnMock = vi.fn()
    spawnMock
      .mockImplementationOnce(() =>
        createHookSpawnStub({
          error: Object.assign(new Error('spawn pwsh ENOENT'), { code: 'ENOENT' })
        })
      )
      .mockImplementationOnce(() =>
        createHookSpawnStub({
          stdout: '{"action":"continue"}'
        })
      )

    const result = await runCommandHookWithDependencies(
      commandHook('hook-command --secret token'),
      preTool('f'),
      {},
      {
        spawn: spawnMock,
        resolveShell: () => shells
      }
    )

    expect(result).toEqual({ action: 'continue' })
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(firstSpawnCommand(spawnMock)).toBe('pwsh')
    expect(spawnMock.mock.calls[1]?.[0]).toBe('powershell.exe')
  })

  it('does not retry a fallback shell when the hook command exits non-zero', async () => {
    const spawnMock = vi.fn(() =>
      createHookSpawnStub({
        stderr: 'hook failed',
        closeCode: 1
      })
    )

    await expect(
      runCommandHookWithDependencies(commandHook('hook-command'), preTool('f'), {}, {
        spawn: spawnMock,
        resolveShell: () => shells
      })
    ).rejects.toThrow("hook 'command-hook' exited with 1: hook failed")

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(firstSpawnCommand(spawnMock)).toBe('pwsh')
  })

  it('maps exit code 2 to block decision', async () => {
    const result = await runCommandHookWithDependencies(
      commandHook('hook-command'),
      preTool('f'),
      {},
      {
        spawn: () =>
          createHookSpawnStub({
            stderr: 'dangerous command',
            closeCode: 2
          }),
        resolveShell: () => shells
      }
    )

    expect(result).toEqual({ action: 'block', reason: 'dangerous command' })
  })

  it('maps exit code 3 to warn decision', async () => {
    const result = await runCommandHookWithDependencies(
      commandHook('hook-command'),
      preTool('f'),
      {},
      {
        spawn: () =>
          createHookSpawnStub({
            stdout: 'audit only',
            closeCode: 3
          }),
        resolveShell: () => shells
      }
    )

    expect(result).toEqual({ action: 'warn', message: 'audit only' })
  })

  it('requires exit code 4 stdout to be a modify decision', async () => {
    const result = await runCommandHookWithDependencies(
      commandHook('hook-command'),
      preTool('f'),
      {},
      {
        spawn: () =>
          createHookSpawnStub({
            stdout: '{"action":"modify","input":{"command":"pnpm test:unit"}}',
            closeCode: 4
          }),
        resolveShell: () => shells
      }
    )

    expect(result).toEqual({ action: 'modify', input: { command: 'pnpm test:unit' } })
  })

  it('rejects malformed command hook decisions', async () => {
    await expect(
      runCommandHookWithDependencies(commandHook('hook-command'), preTool('f'), {}, {
        spawn: () =>
          createHookSpawnStub({
            stdout: '{"action":"warn"}'
          }),
        resolveShell: () => shells
      })
    ).rejects.toThrow("hook stdout 'message' must be a string for warn")

    await expect(
      runCommandHookWithDependencies(commandHook('hook-command'), preTool('f'), {}, {
        spawn: () =>
          createHookSpawnStub({
            stdout: '{"action":"modify","prompt":123}'
          }),
        resolveShell: () => shells
      })
    ).rejects.toThrow("hook stdout 'prompt' must be a string for modify")
  })

  it('fails command hooks that exceed the output buffer', async () => {
    await expect(
      runCommandHookWithDependencies(commandHook('hook-command'), preTool('f'), {}, {
        spawn: () =>
          createHookSpawnStub({
            stdout: 'x'.repeat(300_000)
          }),
        resolveShell: () => shells
      })
    ).rejects.toThrow("hook 'command-hook' exceeded output buffer")
  })

  it('does not include the hook command text when shell spawning fails', async () => {
    const spawnMock = vi.fn(() =>
      createHookSpawnStub({
        error: Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })
      })
    )

    await expect(
      runCommandHookWithDependencies(commandHook('hook-command --secret token'), preTool('f'), {}, {
        spawn: spawnMock,
        resolveShell: () => [shells[1]]
      })
    ).rejects.toThrow('[PowerShell 不可用] shell=powershell.exe')

    await expect(
      runCommandHookWithDependencies(commandHook('hook-command --secret token'), preTool('f'), {}, {
        spawn: spawnMock,
        resolveShell: () => [shells[1]]
      })
    ).rejects.not.toThrow('hook-command --secret token')
  })
})

function commandHook(command: string): Extract<HookDefinition, { type: 'command' }> {
  return {
    name: 'command-hook',
    type: 'command',
    event: 'pre_tool_use',
    scope: 'runtime',
    command,
    timeoutMs: 1000
  }
}

function createHookSpawnStub(options: {
  stdout?: string
  stderr?: string
  closeCode?: number | null
  error?: Error
}) {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  stdout.setEncoding = () => undefined
  stderr.setEncoding = () => undefined

  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout
    stderr: typeof stderr
    stdin: { end: (chunk?: string, encoding?: BufferEncoding) => void }
  }
  child.stdout = stdout
  child.stderr = stderr
  child.stdin = {
    end: () => {
      queueMicrotask(() => {
        if (options.error) {
          child.emit('error', options.error)
          return
        }
        if (options.stdout) stdout.emit('data', options.stdout)
        if (options.stderr) stderr.emit('data', options.stderr)
        child.emit('close', options.closeCode ?? 0)
      })
    }
  }

  return child
}

function firstSpawnCommand(spawnMock: ReturnType<typeof vi.fn>): unknown {
  return spawnMock.mock.calls[0]?.[0]
}
