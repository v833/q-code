/**
 * 外部命令型 Hook 执行器：将事件 JSON 写入 stdin，从 stdout 解析决策 JSON。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  isShellNotFoundError,
  resolveShellInvocation,
  type ShellInvocation
} from '../runtime/shell-invocation'
import type { HookCommandDefinition, HookEvent, HookHandlerResult } from './types'

const DEFAULT_TIMEOUT_MS = 5000

type HookSpawn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2]
) => HookChildProcess
type HookShellResolver = (command: string) => ShellInvocation[]
interface HookChildProcess {
  stdout: { setEncoding: (encoding: BufferEncoding) => void; on: (event: 'data', listener: (chunk: unknown) => void) => unknown }
  stderr: { setEncoding: (encoding: BufferEncoding) => void; on: (event: 'data', listener: (chunk: unknown) => void) => unknown }
  stdin: { end: (chunk?: string, encoding?: BufferEncoding) => void }
  on: (
    event: 'error' | 'close',
    listener: ((error: Error) => void) | ((code: number | null) => void)
  ) => unknown
}

const defaultHookDependencies = {
  spawn: spawnHookChild,
  resolveShell: resolveHookShellInvocations
}

function spawnHookChild(
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2]
): HookChildProcess {
  const child = spawn(command, [...args], options)
  if (!child.stdout || !child.stderr || !child.stdin) {
    throw new Error('hook command stdio pipes are unavailable')
  }
  return child as HookChildProcess
}

/**
 * 在事件 cwd 下执行 Hook 命令（Windows 用 pwsh，Unix 用 sh -lc）。
 * @throws 非零退出码、超时或 stdout 非合法决策 JSON
 */
export async function runCommandHook(
  definition: HookCommandDefinition,
  event: HookEvent,
  options: { signal?: AbortSignal } = {}
): Promise<HookHandlerResult | void> {
  return runCommandHookWithDependencies(definition, event, options, defaultHookDependencies)
}

export async function runCommandHookWithDependencies(
  definition: HookCommandDefinition,
  event: HookEvent,
  options: { signal?: AbortSignal } = {},
  dependencies: { spawn: HookSpawn; resolveShell: HookShellResolver }
): Promise<HookHandlerResult | void> {
  const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const signal = mergeAbortSignals(options.signal, controller.signal)
  const shells = dependencies.resolveShell(definition.command)

  const input = JSON.stringify(
    {
      id: randomUUID(),
      hook: {
        name: definition.name,
        scope: definition.scope,
        sourcePath: definition.sourcePath
      },
      ...event
    },
    null,
    2
  )

  return runHookWithShellCandidates(
    definition,
    event,
    input,
    timeoutMs,
    controller,
    signal,
    shells,
    dependencies
  )
}

function runHookWithShellCandidates(
  definition: HookCommandDefinition,
  event: HookEvent,
  input: string,
  timeoutMs: number,
  timeoutController: AbortController,
  signal: AbortSignal,
  shells: ShellInvocation[],
  dependencies: { spawn: HookSpawn }
): Promise<HookHandlerResult | void> {
  return new Promise<HookHandlerResult | void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      timeoutController.abort()
      settle(() => reject(new Error(`hook '${definition.name}' timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const runAt = (index: number): void => {
      if (settled) return
      const shell = shells[index]
      if (!shell) {
        settle(() => reject(new Error('[shell 不可用] 当前环境不支持 Hook 命令。')))
        return
      }
      const child = dependencies.spawn(shell.command, shell.args, {
        cwd: event.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        signal
      })
      let stdout = ''
      let stderr = ''
      let attemptClosed = false

      const closeAttempt = (): boolean => {
        if (attemptClosed || settled) return false
        attemptClosed = true
        return true
      }

      child.stdout.setEncoding('utf-8')
      child.stderr.setEncoding('utf-8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', (error: Error) => {
        if (!closeAttempt()) return
        if (isShellNotFoundError(error) && index + 1 < shells.length) {
          runAt(index + 1)
          return
        }
        const message = isShellNotFoundError(error)
          ? `${shell.unavailableMessage} shell=${shell.command}`
          : error.message
        settle(() => reject(new Error(message)))
      })
      child.on('close', (code: number | null) => {
        if (!closeAttempt()) return
        if (code !== 0) {
          settle(() =>
            reject(
              new Error(
                `hook '${definition.name}' exited with ${code}: ${stderr.trim() || stdout.trim()}`
              )
            )
          )
          return
        }
        try {
          settle(() => resolve(parseHookStdout(stdout)))
        } catch (error) {
          settle(() => reject(error))
        }
      })
      child.stdin.end(input, 'utf-8')
    }

    runAt(0)
  })
}

function resolveHookShellInvocations(command: string): ShellInvocation[] {
  if (process.platform !== 'win32') {
    return [{
      command: 'sh',
      args: ['-lc', command],
      detached: false,
      unavailableMessage: '[sh 不可用] 当前环境不支持 Hook 命令。请确认 sh 在 PATH 中。'
    }]
  }
  const shellResolution = resolveShellInvocation(command)
  if (!shellResolution.ok) throw new Error(shellResolution.unavailableMessage)
  const selectedIndex = shellResolution.candidates.findIndex(
    (candidate) => candidate.command === shellResolution.shell.command
  )
  return shellResolution.candidates.slice(Math.max(0, selectedIndex))
}

function parseHookStdout(stdout: string): HookHandlerResult | void {
  const text = stdout.trim()
  if (!text) return undefined
  const parsed = JSON.parse(text) as unknown
  if (!isRecord(parsed)) throw new Error('hook stdout must be a JSON object')
  const action = parsed.action
  if (action !== 'continue' && action !== 'warn' && action !== 'block' && action !== 'modify') {
    throw new Error("hook stdout 'action' must be continue, warn, block, or modify")
  }
  return parsed as HookHandlerResult
}

function mergeAbortSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal
): AbortSignal {
  if (!external) return internal
  if (external.aborted) return external

  const controller = new AbortController()
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  external.addEventListener('abort', () => abort(external), { once: true })
  internal.addEventListener('abort', () => abort(internal), { once: true })
  return controller.signal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
