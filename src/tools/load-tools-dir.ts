/**
 * 自定义工具目录加载：扫描 `~/.q-code/tools` 与 `<cwd>/.q-code/tools`，
 * 解析 schema.json 并以子进程执行 execute 命令。
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from './registry'
import {
  formatShellInvocation,
  isShellNotFoundError,
  resolveShellInvocation,
  type ShellInvocation
} from '../runtime/shell-invocation'

const TOOL_SCHEMA_FILE = 'schema.json'
const CUSTOM_TOOL_TIMEOUT_MS = 10_000
const CUSTOM_TOOL_MAX_BUFFER = 1024 * 1024

/** 写入自定义工具 execute 子进程 stdin 的协议版本号。 */
export const CUSTOM_TOOL_STDIN_VERSION = 1

/** 扫描用户/项目自定义工具目录后的汇总结果。 */
export interface LoadedCustomToolsResult {
  tools: ToolDefinition[]
  warnings: string[]
}

interface CustomToolSchema extends Omit<ToolDefinition, 'isEnabled' | 'execute'> {
  execute: string
}

interface CustomToolInputEnvelope {
  version: number
  input: unknown
  context: {
    cwd: string
    sessionId?: string
    teammateIdentity?: ToolExecutionContext['teammateIdentity']
  }
}

/** 解析 q-code 主目录（`Q_CODE_HOME` 或 `~/.q-code`）。 */
export function getQCodeHome(): string {
  return process.env.Q_CODE_HOME?.trim() || path.join(os.homedir(), '.q-code')
}

/** 用户级自定义工具目录（`<Q_CODE_HOME>/tools`）。 */
export function getUserToolsDir(): string {
  return path.join(getQCodeHome(), 'tools')
}

/** 项目级自定义工具目录（`<cwd>/.q-code/tools`）。 */
export function getProjectToolsDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.q-code', 'tools')
}

/**
 * 从用户与项目目录加载自定义工具；同名时项目覆盖用户。
 */
export async function loadAllCustomTools(cwd: string): Promise<LoadedCustomToolsResult> {
  const [userResult, projectResult] = await Promise.all([
    loadFromOneDir(getUserToolsDir(), 'user'),
    loadFromOneDir(getProjectToolsDir(cwd), 'project')
  ])

  const byName = new Map<string, ToolDefinition>()
  for (const tool of [...userResult.tools, ...projectResult.tools]) {
    byName.set(tool.name, tool)
  }

  return {
    tools: [...byName.values()],
    warnings: [...userResult.warnings, ...projectResult.warnings]
  }
}

async function loadFromOneDir(
  dir: string,
  _source: 'user' | 'project'
): Promise<LoadedCustomToolsResult> {
  let entries: string[]
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    entries = dirents
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') return { tools: [], warnings: [] }
    return { tools: [], warnings: [`[tools] Failed to read ${dir}: ${formatError(error)}`] }
  }

  const tools: ToolDefinition[] = []
  const warnings: string[] = []

  for (const entry of entries) {
    const toolDir = path.join(dir, entry)
    const schemaPath = path.join(toolDir, TOOL_SCHEMA_FILE)
    let raw: string
    try {
      raw = await fs.readFile(schemaPath, 'utf-8')
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err?.code === 'ENOENT') {
        warnings.push(`[tools] Skipping ${entry}: missing ${TOOL_SCHEMA_FILE}`)
      } else {
        warnings.push(`[tools] Skipping ${toolDir}: ${formatError(error)}`)
      }
      continue
    }

    let parsed: CustomToolSchema
    try {
      parsed = JSON.parse(raw) as CustomToolSchema
    } catch (error) {
      warnings.push(`[tools] Skipping ${entry}: invalid schema.json (${formatError(error)})`)
      continue
    }

    const normalized = normalizeCustomToolSchema(parsed, entry, toolDir)
    if ('warning' in normalized) {
      warnings.push(normalized.warning)
      continue
    }
    tools.push(normalized.tool)
  }

  return { tools, warnings }
}

function normalizeCustomToolSchema(
  raw: CustomToolSchema,
  dirName: string,
  toolDir: string,
): { tool: ToolDefinition } | { warning: string } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const executeCommand = typeof raw.execute === 'string' ? raw.execute.trim() : ''
  if (!name) {
    return { warning: `[tools] Skipping ${toolDir}: missing required 'name' field` }
  }
  if (!description) {
    return { warning: `[tools] Skipping ${name}: missing required 'description' field` }
  }
  if (name !== dirName) {
    return {
      warning: `[tools] Skipping ${dirName}: schema name '${name}' must match directory name`
    }
  }
  if (!isPlainObject(raw.parameters)) {
    return { warning: `[tools] Skipping ${name}: 'parameters' must be a JSON schema object` }
  }
  if (!executeCommand) {
    return { warning: `[tools] Skipping ${name}: missing required 'execute' field` }
  }

  const realToolDirPromise = fs.realpath(toolDir).catch(() => toolDir)
  const tool: ToolDefinition = {
    name,
    description,
    parameters: raw.parameters,
    ...(typeof raw.isConcurrencySafe === 'boolean'
      ? { isConcurrencySafe: raw.isConcurrencySafe }
      : {}),
    ...(typeof raw.isReadOnly === 'boolean' ? { isReadOnly: raw.isReadOnly } : {}),
    ...(typeof raw.allowInPlanMode === 'boolean' ? { allowInPlanMode: raw.allowInPlanMode } : {}),
    ...(typeof raw.maxResultChars === 'number' ? { maxResultChars: raw.maxResultChars } : {}),
    ...(typeof raw.shouldDefer === 'boolean' ? { shouldDefer: raw.shouldDefer } : {}),
    ...(typeof raw.searchHint === 'string' ? { searchHint: raw.searchHint } : {}),
    ...(raw.contextCost === 'low' || raw.contextCost === 'medium' || raw.contextCost === 'high'
      ? { contextCost: raw.contextCost }
      : {}),
    ...(typeof raw.resultShape === 'string' ? { resultShape: raw.resultShape } : {}),
    ...(typeof raw.jitHint === 'string' ? { jitHint: raw.jitHint } : {}),
    execute: async (input, context) => {
      const realToolDir = await realToolDirPromise
      return executeCustomToolCommand(executeCommand, realToolDir, input, context)
    }
  }

  return { tool }
}

/**
 * 在 `toolDir` 下执行自定义工具的 execute 命令，向 stdin 写入版本化 JSON 信封。
 * 优先解析 stdout 为 JSON 结构化输出；否则返回纯文本或错误信封。
 */
export async function executeCustomToolCommand(
  command: string,
  toolDir: string,
  input: unknown,
  context: ToolExecutionContext
): Promise<ToolExecutionOutput> {
  return new Promise((resolve) => {
    if (context.abortSignal?.aborted) {
      resolve({
        ok: false,
        error: 'Custom tool aborted before start.',
        code: 'tool_aborted',
        metadata: { toolDir }
      })
      return
    }

    const env = {
      ...process.env,
      Q_CODE_TOOL_DIR: toolDir,
      Q_CODE_TOOL_CWD: context.cwd
    }
    const direct = parseDirectCommand(command)
    const shellResolution = direct ? undefined : resolveShellInvocation(command)
    if (shellResolution && !shellResolution.ok) {
      resolve({
        ok: false,
        error: shellResolution.unavailableMessage,
        code: 'tool_spawn_failed',
        metadata: {
          toolDir,
          candidates: shellResolution.candidates.map((candidate) => candidate.command)
        }
      })
      return
    }
    const shell = shellResolution?.shell
    const child = direct
      ? spawn(direct.command, direct.args, {
          cwd: toolDir,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      : (() => {
          if (!shellResolution?.ok) throw new Error('Custom tool shell was not resolved.')
          return spawnCustomToolShell(shellResolution.fallbacks, toolDir, env)
        })()

    const envelope: CustomToolInputEnvelope = {
      version: CUSTOM_TOOL_STDIN_VERSION,
      input,
      context: {
        cwd: context.cwd,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context.teammateIdentity ? { teammateIdentity: context.teammateIdentity } : {})
      }
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let killedBy: 'abort' | 'timeout' | 'maxBuffer' | null = null

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')

    const finish = (value: ToolExecutionOutput): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      context.abortSignal?.removeEventListener('abort', onAbort)
      resolve(value)
    }

    const timeout = setTimeout(() => {
      killedBy = 'timeout'
      killChild(child)
    }, CUSTOM_TOOL_TIMEOUT_MS)

    const onAbort = (): void => {
      killedBy = 'abort'
      killChild(child)
    }

    context.abortSignal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => {
      if (killedBy) return
      stdout += chunk
      if (stdout.length + stderr.length > CUSTOM_TOOL_MAX_BUFFER) {
        killedBy = 'maxBuffer'
        killChild(child)
      }
    })
    child.stderr.on('data', (chunk) => {
      if (killedBy) return
      stderr += chunk
      if (stdout.length + stderr.length > CUSTOM_TOOL_MAX_BUFFER) {
        killedBy = 'maxBuffer'
        killChild(child)
      }
    })

    child.on('error', (error) => {
      const message =
        error.message.includes('ENOENT') && !direct
          ? shell?.unavailableMessage
          : `Custom tool spawn failed: ${error.message}`
      finish({
        ok: false,
        error: message,
        code: 'tool_spawn_failed',
        metadata: {
          toolDir,
          ...(!direct && shell ? { shell: formatShellInvocation(shell) } : {})
        }
      })
    })

    child.on('close', (code, signal) => {
      if (killedBy === 'abort') {
        finish({
          ok: false,
          error: 'Custom tool aborted.',
          code: 'tool_aborted',
          metadata: { toolDir }
        })
        return
      }
      if (killedBy === 'timeout') {
        finish({
          ok: false,
          error: stderr || stdout || `Custom tool timed out after ${CUSTOM_TOOL_TIMEOUT_MS}ms.`,
          code: 'tool_timeout',
          metadata: { toolDir }
        })
        return
      }
      if (killedBy === 'maxBuffer') {
        finish({
          ok: false,
          error: stderr || stdout || 'Custom tool exceeded output buffer.',
          code: 'tool_max_buffer',
          metadata: { toolDir }
        })
        return
      }
      if (code !== 0) {
        finish({
          ok: false,
          error: stderr || stdout || `Custom tool exited with ${code ?? signal ?? 1}.`,
          code: 'tool_exit_nonzero',
          metadata: { toolDir, exitCode: code ?? signal ?? 1 }
        })
        return
      }

      const trimmed = stdout.trim()
      if (!trimmed) {
        finish('')
        return
      }
      try {
        finish(JSON.parse(trimmed) as ToolExecutionOutput)
      } catch {
        finish(stdout)
      }
    })

    child.stdin.end(JSON.stringify(envelope))
  })
}

function spawnCustomToolShell(
  shells: ShellInvocation[],
  toolDir: string,
  env: NodeJS.ProcessEnv
) {
  let lastShell = shells[0]
  for (const shell of shells) {
    lastShell = shell
    try {
      return spawn(shell.command, shell.args, {
        cwd: toolDir,
        env,
        detached: shell.detached,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      if (!isShellNotFoundError(error)) throw error
    }
  }
  const error = Object.assign(new Error(`spawn ${lastShell.command} ENOENT`), { code: 'ENOENT' })
  throw error
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDirectCommand(command: string): { command: string; args: string[] } | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (/[|&;<>()`]/.test(trimmed)) return null

  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index]
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && index + 1 < trimmed.length) {
        const next = trimmed[index + 1]
        if (next === '"' || next === '\\') {
          current += next
          index++
        } else {
          current += char
        }
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (quote) return null
  if (current) tokens.push(current)
  if (tokens.length === 0) return null

  return {
    command: tokens[0],
    args: tokens.slice(1)
  }
}

function killChild(child: {
  pid?: number
  kill: (signal?: NodeJS.Signals | number) => boolean
}): void {
  try {
    child.kill('SIGTERM')
  } catch {
    /* noop */
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
