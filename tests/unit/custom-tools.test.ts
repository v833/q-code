import { EventEmitter } from 'node:events'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'
import { ToolRegistry, type ToolDefinition } from '../../src/tools/registry'
import {
  CUSTOM_TOOL_STDIN_VERSION,
  executeCustomToolCommand,
  getProjectToolsDir,
  getUserToolsDir,
  loadAllCustomTools
} from '../../src/tools/load-tools-dir'

const homes: TempHome[] = []
const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

afterEach(() => {
  spawnMock.mockReset()
  for (const home of homes.splice(0)) home.dispose()
})

function trackHome(label?: string): TempHome {
  const home = setupTempHome(label)
  homes.push(home)
  return home
}

function writeCustomTool(baseDir: string, toolName: string, schema: Record<string, unknown>): string {
  const toolDir = join(baseDir, toolName)
  mkdirSync(toolDir, { recursive: true })
  writeFileSync(join(toolDir, 'schema.json'), JSON.stringify(schema, null, 2), 'utf-8')
  return toolDir
}

function makeBuiltInTool(name: string, output: unknown): ToolDefinition {
  return {
    name,
    description: `builtin ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async () => output
  }
}

function createSpawnStub(options: {
  stdout?: string
  stderr?: string
  closeCode?: number | null
  closeSignal?: NodeJS.Signals | null
  error?: Error
  onStdinEnd?: (payload: string) => void
}) {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void }
  stdout.setEncoding = () => undefined
  stderr.setEncoding = () => undefined

  let stdinPayload = ''
  const stdin = {
    end: (chunk?: string) => {
      if (chunk) stdinPayload += chunk
      options.onStdinEnd?.(stdinPayload)
      queueMicrotask(() => {
        if (options.error) {
          child.emit('error', options.error)
          return
        }
        if (options.stdout) stdout.emit('data', options.stdout)
        if (options.stderr) stderr.emit('data', options.stderr)
        child.emit('close', options.closeCode ?? 0, options.closeSignal ?? null)
      })
    }
  }

  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout
    stderr: typeof stderr
    stdin: typeof stdin
    kill: (signal?: NodeJS.Signals | number) => boolean
  }
  child.stdout = stdout
  child.stderr = stderr
  child.stdin = stdin
  child.kill = () => true
  return child
}

describe('custom tool loader', () => {
  it('loads user and project tools, with project overriding user on name collision', async () => {
    const home = trackHome('q-code-custom-tools-')
    const userToolsDir = getUserToolsDir()
    const projectToolsDir = getProjectToolsDir(home.cwd)

    writeCustomTool(userToolsDir, 'shared_tool', {
      name: 'shared_tool',
      description: 'user tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: 'node -e "process.stdout.write(\'user\')"'
    })
    writeCustomTool(projectToolsDir, 'shared_tool', {
      name: 'shared_tool',
      description: 'project tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: 'node -e "process.stdout.write(\'project\')"'
    })
    writeCustomTool(projectToolsDir, 'project_only', {
      name: 'project_only',
      description: 'project only',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isReadOnly: false,
      isConcurrencySafe: false,
      execute: 'node -e "process.stdout.write(\'ok\')"'
    })

    const loaded = await loadAllCustomTools(home.cwd)
    expect(loaded.warnings).toEqual([])
    expect(loaded.tools.map((tool) => `${tool.name}:${tool.description}`).sort()).toEqual([
      'project_only:project only',
      'shared_tool:project tool'
    ])
  })

  it('registry order lets custom tools override built-in tools', async () => {
    const home = trackHome('q-code-custom-tools-override-')
    const projectToolsDir = getProjectToolsDir(home.cwd)
    writeCustomTool(projectToolsDir, 'read_file', {
      name: 'read_file',
      description: 'custom read override',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: 'node -e "process.stdout.write(\'custom\')"'
    })

    spawnMock.mockImplementation(() =>
      createSpawnStub({
        stdout: 'custom'
      })
    )

    const builtIn = makeBuiltInTool('read_file', 'builtin')
    const custom = await loadAllCustomTools(home.cwd)
    const customToolNames = new Set(custom.tools.map((tool) => tool.name))
    const registry = new ToolRegistry({ cwd: home.cwd, quiet: true })
    registry.register(...[builtIn].filter((tool) => !customToolNames.has(tool.name)))
    registry.register(...custom.tools)

    const result = await registry.toAISDKFormat().read_file.execute({}, { toolCallId: 'tc1', messages: [] })
    expect(result).toBe('custom')
  })

  it('execute command runs inside tool directory and receives stdin payload', async () => {
    const home = trackHome('q-code-custom-tools-exec-')
    const projectToolsDir = getProjectToolsDir(home.cwd)
    const toolDir = writeCustomTool(projectToolsDir, 'inspect_input', {
      name: 'inspect_input',
      description: 'inspect input',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        },
        required: ['value'],
        additionalProperties: false
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: 'node ./index.js'
    })
    spawnMock.mockImplementation((_command: string, _args: string[], spawnOptions: { cwd: string }) =>
      createSpawnStub({
        onStdinEnd: (payload) => {
          const parsed = JSON.parse(payload)
          expect(parsed).toEqual({
            version: CUSTOM_TOOL_STDIN_VERSION,
            input: { value: 'hello' },
            context: {
              cwd: home.cwd,
              sessionId: 's1'
            }
          })
        },
        stdout: JSON.stringify({
          ok: true,
          content: {
            value: 'hello',
            cwd: spawnOptions.cwd,
            sessionId: 's1',
            version: true
          }
        })
      })
    )

    const loaded = await loadAllCustomTools(home.cwd)
    const tool = loaded.tools.find((entry) => entry.name === 'inspect_input')
    expect(tool).toBeDefined()

    const result = await tool!.execute(
      { value: 'hello' },
      { cwd: home.cwd, sessionId: 's1' }
    )
    expect(result).toEqual({
      ok: true,
      content: {
        value: 'hello',
        cwd: realpathSync(toolDir),
        sessionId: 's1',
        version: true
      }
    })
  })

  it('warns when a tool directory is missing schema.json', async () => {
    const home = trackHome('q-code-custom-tools-missing-schema-')
    const projectToolsDir = getProjectToolsDir(home.cwd)
    mkdirSync(join(projectToolsDir, 'empty_tool'), { recursive: true })

    const loaded = await loadAllCustomTools(home.cwd)
    expect(loaded.tools).toEqual([])
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain('empty_tool')
    expect(loaded.warnings[0]).toContain('schema.json')
  })

  it('returns aborted error without spawning when abortSignal is already aborted', async () => {
    const home = trackHome('q-code-custom-tools-abort-')
    const toolDir = writeCustomTool(getProjectToolsDir(home.cwd), 'abort_early', {
      name: 'abort_early',
      description: 'abort early',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: 'node -e "1"'
    })
    const controller = new AbortController()
    controller.abort()

    const result = await executeCustomToolCommand('node -e "1"', toolDir, {}, {
      cwd: home.cwd,
      abortSignal: controller.signal
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'tool_aborted'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('surfaces invalid schema files as warnings and skips them', async () => {
    const home = trackHome('q-code-custom-tools-invalid-')
    const projectToolsDir = getProjectToolsDir(home.cwd)
    const toolDir = join(projectToolsDir, 'broken_tool')
    mkdirSync(toolDir, { recursive: true })
    writeFileSync(join(toolDir, 'schema.json'), '{not-valid-json', 'utf-8')

    const loaded = await loadAllCustomTools(home.cwd)
    expect(loaded.tools).toEqual([])
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain('broken_tool')
  })

  it('execute helper falls back to plain stdout when output is not json', async () => {
    const home = trackHome('q-code-custom-tools-plain-')
    const toolDir = writeCustomTool(getProjectToolsDir(home.cwd), 'plain_output', {
      name: 'plain_output',
      description: 'plain output',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: 'node -e "process.stdout.write(\'plain text\')"'
    })

    spawnMock.mockImplementation(() =>
      createSpawnStub({
        stdout: 'plain text'
      })
    )

    const result = await executeCustomToolCommand(
      'node -e "process.stdout.write(\'plain text\')"',
      toolDir,
      {},
      { cwd: home.cwd }
    )
    expect(result).toBe('plain text')
  })

  it('execute helper returns structured error when spawn emits error', async () => {
    const home = trackHome('q-code-custom-tools-spawn-error-')
    const toolDir = writeCustomTool(getProjectToolsDir(home.cwd), 'spawn_error', {
      name: 'spawn_error',
      description: 'spawn error',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: 'node ./index.js'
    })
    spawnMock.mockImplementation(() =>
      createSpawnStub({
        error: Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
      })
    )

    const result = await executeCustomToolCommand('node ./index.js', toolDir, {}, { cwd: home.cwd })
    expect(result).toMatchObject({
      ok: false,
      code: 'tool_spawn_failed'
    })
  })

  it('skips tools whose schema name does not match directory name', async () => {
    const home = trackHome('q-code-custom-tools-name-mismatch-')
    writeCustomTool(getProjectToolsDir(home.cwd), 'dir_name', {
      name: 'other_name',
      description: 'name mismatch',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: 'node -e "process.stdout.write(\'x\')"'
    })

    const loaded = await loadAllCustomTools(home.cwd)
    expect(loaded.tools).toEqual([])
    expect(loaded.warnings[0]).toContain('must match directory name')
  })
})
