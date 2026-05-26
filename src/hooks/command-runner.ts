/**
 * 外部命令型 Hook 执行器：将事件 JSON 写入 stdin，从 stdout 解析决策 JSON。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { HookCommandDefinition, HookEvent, HookHandlerResult } from './types'

const DEFAULT_TIMEOUT_MS = 5000

/**
 * 在事件 cwd 下执行 Hook 命令（Windows 用 pwsh，Unix 用 sh -lc）。
 * @throws 非零退出码、超时或 stdout 非合法决策 JSON
 */
export async function runCommandHook(
  definition: HookCommandDefinition,
  event: HookEvent,
  options: { signal?: AbortSignal } = {}
): Promise<HookHandlerResult | void> {
  const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const signal = mergeAbortSignals(options.signal, controller.signal)
  const command = process.platform === 'win32' ? 'pwsh' : 'sh'
  const args =
    process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', definition.command]
      : ['-lc', definition.command]

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

  return await new Promise<HookHandlerResult | void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: event.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      signal
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      controller.abort()
      settle(() => reject(new Error(`hook '${definition.name}' timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      settle(() => reject(error))
    })
    child.on('close', (code) => {
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
  })
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
