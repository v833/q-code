/**
 * Shell 工具（`f`）与后台 job 管理：超时、输出 spill、危险命令 lint、cwd 策略。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { errorToolResult, okToolResult, type ToolDefinition, type ToolExecutionContext } from './registry'
import { isInsideDirectory } from './path-policy'
import { isFalseEnv } from '../utils/env'
import {
  formatShellInvocation,
  getShellInvocation,
  isShellNotFoundError,
  resolveShellInvocation,
  type ShellInvocation
} from '../runtime/shell-invocation'

const DEFAULT_SHELL_TIMEOUT_MS = 60_000
const DEFAULT_SHELL_TIMEOUT_MAX_MS = 1_800_000
const DEFAULT_SHELL_MAX_BUFFER = 4 * 1024 * 1024
const STDIN_MAX_CHARS = 64 * 1024
const SUMMARY_HEAD_CHARS = 4000
const SUMMARY_TAIL_CHARS = 4000
const INTERACTIVE_GRACE_MS = 5000
const DEFAULT_TAIL_MAX_BYTES = 64 * 1024
const SHELL_COMPLETED_JOB_RETENTION = 100

export { getShellInvocation, type ShellInvocation }

interface ShellToolInput {
  command: string
  cwd?: string
  timeoutMs?: number
  maxBufferBytes?: number
  background?: boolean
  stdin?: string
  env?: Record<string, string>
  label?: string
}

interface ShellJob {
  jobId: string
  command: string
  label?: string
  cwd: string
  pid?: number
  outputFile: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  durationMs?: number
  bytes: number
  sessionId?: string
  child?: ChildProcess
  outputFd?: number
}

/** `lintShellCommand` 的静态检查结果。 */
export interface ShellCommandLintResult {
  blocked: boolean
  code?: 'dangerous_command'
  message?: string
  warnings: string[]
}

const shellJobs = new Map<string, ShellJob>()
let shellProcessCleanupRegistered = false

/** 主 shell 执行工具（名称 `f`），支持前台/后台与 spill。 */
export const bashTool: ToolDefinition = {
  name: 'f',
  description:
    '执行 shell 命令。支持 timeoutMs/maxBufferBytes/cwd/env/stdin/background；长任务可后台运行后用 f_tail/f_status/f_kill 查询',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      cwd: { type: 'string', description: '可选工作目录，默认当前项目目录' },
      timeoutMs: {
        type: 'number',
        description: '同步命令超时，默认 Q_CODE_SHELL_TIMEOUT_MS 或 60000，最大 Q_CODE_SHELL_TIMEOUT_MAX_MS'
      },
      maxBufferBytes: {
        type: 'number',
        description: '同步输出内存阈值，默认 Q_CODE_SHELL_MAX_BUFFER 或 4MB；超出后落盘 spill'
      },
      background: { type: 'boolean', description: '为 true 时后台运行并立即返回 jobId' },
      stdin: { type: 'string', description: '写入子进程 stdin 的短文本' },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: '追加环境变量'
      },
      label: { type: 'string', description: '后台 job 或 TUI 显示标签' }
    },
    required: ['command'],
    additionalProperties: false
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  contextCost: 'high',
  resultShape: 'command-output',
  jitHint: '长命令设置 timeoutMs；服务/监听类命令用 background=true 后再 f_tail',
  maxResultChars: 12000,
  execute: async (input: ShellToolInput, context: ToolExecutionContext) => {
    if (input.background === true) return startBackgroundShellCommand(input, context)
    return runShellCommand(input, context)
  }
}

/** 查询后台 shell job 状态（`f_status`）。 */
export const shellStatusTool: ToolDefinition = {
  name: 'f_status',
  description: '查询 f 后台 shell job 状态',
  parameters: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'f background 返回的 jobId' }
    },
    required: ['jobId'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  contextCost: 'low',
  resultShape: 'state',
  execute: ({ jobId }: { jobId: string }, context: ToolExecutionContext) => {
    const job = shellJobs.get(jobId)
    if (!job) return errorToolResult(`未找到 shell job: ${jobId}`, { code: 'job_not_found' })
    return okToolResult(formatJobStatus(job), { jobId })
  }
}

/** 读取后台 job 输出尾部（`f_tail`）。 */
export const shellTailTool: ToolDefinition = {
  name: 'f_tail',
  description: '读取 f 后台 shell job 输出，支持 fromOffset/maxBytes 增量读取',
  parameters: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'f background 返回的 jobId' },
      fromOffset: { type: 'number', description: '读取起始字节 offset，默认 0' },
      maxBytes: { type: 'number', description: '最多读取字节数，默认 65536' }
    },
    required: ['jobId'],
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  contextCost: 'medium',
  resultShape: 'command-output',
  maxResultChars: 12000,
  execute: ({ jobId, fromOffset, maxBytes }: { jobId: string; fromOffset?: number; maxBytes?: number }) => {
    const job = shellJobs.get(jobId)
    if (!job) return errorToolResult(`未找到 shell job: ${jobId}`, { code: 'job_not_found' })
    return okToolResult(readJobTail(job, fromOffset, maxBytes), { jobId })
  }
}

/** 终止后台 shell job（`f_kill`）。 */
export const shellKillTool: ToolDefinition = {
  name: 'f_kill',
  description: '终止 f 后台 shell job',
  parameters: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'f background 返回的 jobId' }
    },
    required: ['jobId'],
    additionalProperties: false
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  contextCost: 'low',
  resultShape: 'mutation',
  execute: ({ jobId }: { jobId: string }, context: ToolExecutionContext) => {
    const job = shellJobs.get(jobId)
    if (!job) return errorToolResult(`未找到 shell job: ${jobId}`, { code: 'job_not_found' })
    if (job.status !== 'running') return okToolResult(formatJobStatus(job), { jobId })
    job.status = 'killed'
    job.finishedAt = new Date().toISOString()
    job.durationMs = Date.now() - Date.parse(job.startedAt)
    terminateProcessTree(job.pid)
    closeJobOutput(job)
    job.child = undefined
    appendJobIndex(job, context.sessionId)
    pruneCompletedShellJobs()
    return okToolResult(formatJobStatus(job), { jobId })
  }
}

/** 列出当前会话的后台 shell job（`f_list`）。 */
export const shellListTool: ToolDefinition = {
  name: 'f_list',
  description: '列出当前进程内 f 后台 shell jobs',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  contextCost: 'low',
  resultShape: 'state',
  execute: () => okToolResult([...shellJobs.values()].map(formatJobStatus))
}

async function runShellCommand(input: ShellToolInput, context: ToolExecutionContext) {
  const prepared = prepareShellRun(input, context)
  if (!prepared.ok) return prepared.error
  if (context.abortSignal?.aborted) {
    return shellError('命令执行失败 (aborted)', 'aborted', {
      killedBy: 'abort',
      cwd: prepared.cwd,
      shell: formatShellInvocation(prepared.shell),
      stdoutTail: '',
      stderrTail: formatAbortReason(context.abortSignal),
      durationMs: 0
    })
  }

  return new Promise((resolve) => {
    const started = Date.now()
    let stdoutTail = ''
    let stderrTail = ''
    let memoryOutput = ''
    let summaryHead = ''
    let summaryTail = ''
    let spillFile: string | undefined
    let killedBy: 'abort' | 'timeout' | 'interactive' | null = null
    let settled = false
    let bytes = 0
    let interactiveTimer: ReturnType<typeof setTimeout> | undefined
    let currentChild: ChildProcess | undefined
    let currentShell = prepared.shell
    const progress = createShellProgressEmitter(context, input.label ?? input.command)

    const finish = (result: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const timeout = setTimeout(() => {
      killedBy = 'timeout'
      terminateProcessTree(currentChild?.pid)
    }, prepared.timeoutMs)
    timeout.unref()

    const onAbort = (): void => {
      killedBy = 'abort'
      terminateProcessTree(currentChild?.pid)
    }

    const cleanup = (): void => {
      clearTimeout(timeout)
      if (interactiveTimer) clearTimeout(interactiveTimer)
      progress.flush()
      context.abortSignal?.removeEventListener('abort', onAbort)
    }

    const ensureSpill = (nextChunk: string): string => {
      if (spillFile) return spillFile
      spillFile = join(getQCodeDir('shell-spills'), `${createShellJobId()}.log`)
      writeFileSync(spillFile, memoryOutput + nextChunk, 'utf-8')
      memoryOutput = ''
      return spillFile
    }

    const appendOutput = (target: 'stdout' | 'stderr', chunk: string): void => {
      if (settled) return
      const displayChunk = target === 'stderr' ? `[stderr] ${chunk}` : chunk
      const chunkBytes = Buffer.byteLength(displayChunk, 'utf-8')
      if (target === 'stdout') stdoutTail = appendTail(stdoutTail, chunk, SUMMARY_TAIL_CHARS)
      else stderrTail = appendTail(stderrTail, chunk, SUMMARY_TAIL_CHARS)
      summaryHead = appendHead(summaryHead, displayChunk, SUMMARY_HEAD_CHARS)
      summaryTail = appendTail(summaryTail, displayChunk, SUMMARY_TAIL_CHARS)
      bytes += chunkBytes
      if (spillFile) {
        appendFileSync(spillFile, displayChunk, 'utf-8')
      } else if (bytes > prepared.maxBufferBytes) {
        ensureSpill(displayChunk)
      } else {
        memoryOutput += displayChunk
      }
      progress.push(target, chunk)
      if (!killedBy && looksInteractive(chunk)) {
        interactiveTimer ??= setTimeout(() => {
          killedBy = 'interactive'
          terminateProcessTree(currentChild?.pid)
        }, INTERACTIVE_GRACE_MS)
        interactiveTimer.unref()
      }
    }

    context.abortSignal?.addEventListener('abort', onAbort, { once: true })

    const runAt = (index: number): void => {
      if (settled) return
      currentShell = prepared.shellFallbacks[index] ?? prepared.shell
      const child = spawn(currentShell.command, currentShell.args, {
        cwd: prepared.cwd,
        env: buildChildEnv(input.env),
        detached: currentShell.detached,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      currentChild = child
      let attemptClosed = false
      const closeAttempt = (): boolean => {
        if (attemptClosed || settled) return false
        attemptClosed = true
        return true
      }

      child.stdout.setEncoding('utf-8')
      child.stderr.setEncoding('utf-8')
      child.stdout.on('data', (chunk) => appendOutput('stdout', String(chunk)))
      child.stderr.on('data', (chunk) => appendOutput('stderr', String(chunk)))
      child.on('error', (error) => {
        if (!closeAttempt()) return
        if (isShellNotFoundError(error) && index + 1 < prepared.shellFallbacks.length) {
          runAt(index + 1)
          return
        }
        const message = isShellNotFoundError(error)
          ? currentShell.unavailableMessage
          : `命令执行失败 (spawn error): ${error.message}`
        finish(
          shellError(message, isShellNotFoundError(error) ? 'shell_unavailable' : 'spawn_error', {
            cwd: prepared.cwd,
            shell: formatShellInvocation(currentShell),
            durationMs: Date.now() - started,
            stdoutTail,
            stderrTail
          })
        )
      })
      child.on('close', (code, signal) => {
        if (!closeAttempt()) return
        const durationMs = Date.now() - started
        const metadata = {
          exitCode: code,
          signal,
          killedBy,
          durationMs,
          shell: formatShellInvocation(currentShell),
          cwd: prepared.cwd,
          stderrTail: stderrTail.slice(-2000),
          stdoutTail: stdoutTail.slice(-500),
          ...(spillFile ? { spillFile } : {}),
          bytes
        }
        if (killedBy === 'abort') {
          finish(shellError('命令执行失败 (aborted)', 'aborted', metadata))
          return
        }
        if (killedBy === 'timeout') {
          finish(shellError(`命令执行失败 (timeout ${prepared.timeoutMs}ms)`, 'timeout', metadata))
          return
        }
        if (killedBy === 'interactive') {
          finish(
            shellError(
              '此命令需要交互，请在外部终端执行后再继续。',
              'interactive_not_supported',
              metadata
            )
          )
          return
        }
        if (code === 0) {
          const output = renderShellSuccess({
            output: spillFile ? undefined : memoryOutput,
            head: summaryHead,
            tail: summaryTail,
            bytes,
            spillFile,
            warnings: prepared.lint.warnings,
            durationMs
          })
          finish(output)
          return
        }
        finish(shellError(`命令执行失败 (exit ${code ?? signal ?? 1})`, 'exit_nonzero', metadata))
      })

      if (input.stdin !== undefined) {
        child.stdin.write(input.stdin.slice(0, STDIN_MAX_CHARS))
      }
      child.stdin.end()
    }

    runAt(0)
  })
}

function startBackgroundShellCommand(input: ShellToolInput, context: ToolExecutionContext) {
  const prepared = prepareShellRun(input, context)
  if (!prepared.ok) return prepared.error
  registerShellProcessCleanup()

  const jobId = createShellJobId()
  const outputFile = join(getQCodeDir('shell-jobs'), `${jobId}.log`)
  writeFileSync(outputFile, '', 'utf-8')
  const startedAt = new Date().toISOString()
  const outputFd = openSync(outputFile, 'a')
  let child: ChildProcess
  let shell = prepared.shell
  try {
    child = spawnBackgroundShell(prepared.shellFallbacks, prepared.cwd, input, outputFd)
    shell = prepared.shellFallbacks.find((candidate) => candidate.command === child.spawnfile) ?? shell
  } catch (error) {
    closeSync(outputFd)
    const code = isShellNotFoundError(error) ? 'shell_unavailable' : 'spawn_error'
    const message = isShellNotFoundError(error)
      ? shell.unavailableMessage
      : `命令执行失败 (spawn error): ${formatUnknownError(error)}`
    return shellError(message, code, {
      cwd: prepared.cwd,
      shell: formatShellInvocation(shell),
      durationMs: Date.now() - Date.parse(startedAt)
    })
  }

  const job: ShellJob = {
    jobId,
    command: input.command,
    ...(input.label ? { label: input.label } : {}),
    cwd: prepared.cwd,
    pid: child.pid,
    outputFile,
    startedAt,
    status: 'running',
    bytes: 0,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    child,
    outputFd
  }
  shellJobs.set(jobId, job)
  appendJobIndex(job, context.sessionId)

  child.on('error', (error) => {
    job.status = 'failed'
    job.finishedAt = new Date().toISOString()
    job.durationMs = Date.now() - Date.parse(startedAt)
    closeJobOutput(job)
    appendFileSync(outputFile, `[spawn error] ${error.message}\n`, 'utf-8')
    appendJobIndex(job, context.sessionId)
    pruneCompletedShellJobs()
  })
  child.on('close', (code, signal) => {
    if (job.status === 'killed') return
    closeJobOutput(job)
    job.status = code === 0 ? 'completed' : 'failed'
    job.exitCode = code
    job.signal = signal
    job.finishedAt = new Date().toISOString()
    job.durationMs = Date.now() - Date.parse(startedAt)
    job.child = undefined
    appendJobIndex(job, context.sessionId)
    pruneCompletedShellJobs()
  })
  child.unref()
  if (child.stdin) {
    if (input.stdin !== undefined) child.stdin.write(input.stdin.slice(0, STDIN_MAX_CHARS))
    child.stdin.end()
  }

  return okToolResult(
    {
      jobId,
      command: input.command,
      cwd: prepared.cwd,
      pid: child.pid,
      outputFile,
      startedAt,
      ...(prepared.lint.warnings.length > 0 ? { warnings: prepared.lint.warnings } : {})
    },
    { jobId, outputFile }
  )
}

function prepareShellRun(
  input: ShellToolInput,
  context: ToolExecutionContext
):
  | {
      ok: true
      cwd: string
      timeoutMs: number
      maxBufferBytes: number
      shell: ShellInvocation
      shellFallbacks: ShellInvocation[]
      lint: ShellCommandLintResult
    }
  | { ok: false; error: ReturnType<typeof errorToolResult> } {
  if (!input.command?.trim()) {
    return { ok: false, error: errorToolResult('command 不能为空', { code: 'invalid_command' }) }
  }
  const lint = lintShellCommand(input.command)
  if (lint.blocked) {
    return {
      ok: false,
      error: errorToolResult(lint.message ?? '危险命令已拦截', {
        code: lint.code,
        metadata: { warnings: lint.warnings }
      })
    }
  }
  const cwd = resolveShellCwd(context.cwd, input.cwd)
  if (!cwd.ok) return { ok: false, error: cwd.error }
  const cwdValidation = validateShellCwd(cwd.cwd)
  if (!cwdValidation.ok) return { ok: false, error: cwdValidation.error }
  const shellResolution = resolveShellInvocation(input.command)
  if (!shellResolution.ok) {
    return {
      ok: false,
      error: errorToolResult(shellResolution.unavailableMessage, {
        code: 'shell_unavailable',
        metadata: {
          candidates: shellResolution.candidates.map((candidate) => candidate.command)
        }
      })
    }
  }
  const timeoutMs = normalizeTimeoutMs(input.timeoutMs)
  const maxBufferBytes = normalizePositiveInt(input.maxBufferBytes, getDefaultMaxBufferBytes())
  return {
    ok: true,
    cwd: cwd.cwd,
    timeoutMs,
    maxBufferBytes,
    shell: shellResolution.shell,
    shellFallbacks: shellResolution.fallbacks,
    lint
  }
}

function spawnBackgroundShell(
  shells: ShellInvocation[],
  cwd: string,
  input: ShellToolInput,
  outputFd: number
): ChildProcess {
  let lastShell = shells[0]
  for (const shell of shells) {
    lastShell = shell
    try {
      return spawn(shell.command, shell.args, {
        cwd,
        env: buildChildEnv(input.env),
        detached: shell.detached,
        stdio: ['pipe', outputFd, outputFd],
        windowsHide: true
      })
    } catch (error) {
      if (!isShellNotFoundError(error)) throw error
    }
  }
  const error = Object.assign(new Error(`spawn ${lastShell.command} ENOENT`), { code: 'ENOENT' })
  throw error
}

function resolveShellCwd(rootCwd: string, requested: string | undefined) {
  const root = resolve(rootCwd)
  const cwd = requested?.trim() ? resolve(root, requested) : root
  if (isInsideDirectory(root, cwd) || isShellAbsCwdAllowed()) return { ok: true as const, cwd }
  return {
    ok: false as const,
    error: errorToolResult(`cwd 越界: ${cwd} 不在当前工作目录 ${root} 内`, {
      code: 'cwd_not_allowed',
      metadata: { cwd, root }
    })
  }
}

function validateShellCwd(cwd: string) {
  try {
    const stat = statSync(cwd)
    if (stat.isDirectory()) return { ok: true as const }
    return {
      ok: false as const,
      error: errorToolResult(`cwd 不是目录: ${cwd}`, {
        code: 'cwd_not_directory',
        metadata: { cwd }
      })
    }
  } catch {
    return {
      ok: false as const,
      error: errorToolResult(`cwd 不存在: ${cwd}`, {
        code: 'cwd_not_found',
        metadata: { cwd }
      })
    }
  }
}

/**
 * 检测命令中是否包含针对根目录的 `rm -rf /`（及 `-fr`、拆分 `-r`/`-f`、长选项等常见写法）。
 * 使用词边界 `\brm`，以便拦截 `sudo rm -rf /` 等前缀形式。
 */
function isRmRecursiveForceRoot(command: string): boolean {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim()
  const match = normalized.match(/\brm\s+(.+)$/)
  if (!match) return false

  let recursive = false
  let force = false
  const paths: string[] = []

  for (const token of match[1].split(' ').filter(Boolean)) {
    if (token.startsWith('--')) {
      const longFlag = token.slice(2)
      if (longFlag === 'recursive' || longFlag === 'r') recursive = true
      if (longFlag === 'force' || longFlag === 'f') force = true
      continue
    }
    if (token.startsWith('-')) {
      for (const flag of token.slice(1)) {
        if (flag === 'r') recursive = true
        if (flag === 'f') force = true
      }
      continue
    }
    paths.push(token)
  }

  if (!recursive || !force) return false
  return paths.some((target) => target === '/' || target === '/*')
}

/**
 * 对 shell 命令做静态 lint：拦截危险命令（如根目录 `rm -rf /`、fork bomb、mkfs、危险 dd），
 * 并对 curl/wget 管道到 sh/bash 给出警告。
 */
export function lintShellCommand(command: string): ShellCommandLintResult {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim()
  const warnings: string[] = []
  if (isRmRecursiveForceRoot(command)) {
    return { blocked: true, code: 'dangerous_command', message: '危险命令已拦截: rm -rf /', warnings }
  }
  if (normalized.includes(':(){') || normalized.includes(':() {')) {
    return { blocked: true, code: 'dangerous_command', message: '危险命令已拦截: fork bomb', warnings }
  }
  if (/\bmkfs(?:\.|\s|$)/.test(normalized)) {
    return { blocked: true, code: 'dangerous_command', message: '危险命令已拦截: mkfs', warnings }
  }
  if (/\bdd\s+if=\/dev\/zero\s+of=\/dev\/sd/.test(normalized)) {
    return { blocked: true, code: 'dangerous_command', message: '危险命令已拦截: dd 写磁盘', warnings }
  }
  if (/\bcurl\b[\s\S]*\|\s*(?:sh|bash)\b/.test(normalized)) {
    warnings.push('检测到 curl | sh/bash，请确认来源可信。')
  }
  if (/\bwget\b[\s\S]*\|\s*(?:sh|bash)\b/.test(normalized)) {
    warnings.push('检测到 wget | sh/bash，请确认来源可信。')
  }
  return { blocked: false, warnings }
}

/** Windows 下 taskkill 参数：结束进程树。 */
export function getWindowsProcessTreeKillArgs(pid: number): string[] {
  return ['/F', '/T', '/PID', String(pid)]
}

function renderShellSuccess(args: {
  output?: string
  head: string
  tail: string
  bytes: number
  spillFile?: string
  warnings: string[]
  durationMs: number
}): string {
  const lines: string[] = []
  for (const warning of args.warnings) lines.push(`[warning] ${warning}`)
  if (args.spillFile) {
    lines.push(
      `[shell output spilled] bytes=${args.bytes} durationMs=${args.durationMs}`,
      `file: ${args.spillFile}`,
      '--- head ---',
      args.head || '(empty)',
      '--- tail ---',
      args.tail || '(empty)'
    )
    return lines.join('\n')
  }
  const output = args.output || '(命令执行成功，无输出)'
  lines.push(output)
  return lines.join('\n')
}

function shellError(message: string, code: string, metadata: Record<string, unknown>) {
  return errorToolResult(message, { code, metadata })
}

function buildChildEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS || '4',
    ...sanitizeEnv(extra)
  }
}

function sanitizeEnv(extra: Record<string, string> | undefined): Record<string, string> {
  if (!extra || typeof extra !== 'object') return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    result[key] = String(value)
  }
  return result
}

function normalizeTimeoutMs(value: number | undefined): number {
  const fallback = getDefaultTimeoutMs()
  const max = getMaxTimeoutMs()
  if (value === undefined) return Math.min(fallback, max)
  return Math.min(Math.max(1, Math.floor(value)), max)
}

function getDefaultTimeoutMs(): number {
  return normalizePositiveIntEnv('Q_CODE_SHELL_TIMEOUT_MS', DEFAULT_SHELL_TIMEOUT_MS)
}

function getMaxTimeoutMs(): number {
  return normalizePositiveIntEnv('Q_CODE_SHELL_TIMEOUT_MAX_MS', DEFAULT_SHELL_TIMEOUT_MAX_MS)
}

function getDefaultMaxBufferBytes(): number {
  return normalizePositiveIntEnv('Q_CODE_SHELL_MAX_BUFFER', DEFAULT_SHELL_MAX_BUFFER)
}

function normalizePositiveIntEnv(name: string, fallback: number): number {
  return normalizePositiveInt(Number(process.env[name]?.trim()), fallback)
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function isShellAbsCwdAllowed(): boolean {
  return !isFalseEnv(process.env.Q_CODE_SHELL_ALLOW_ABS_CWD) && process.env.Q_CODE_SHELL_ALLOW_ABS_CWD !== undefined
}

function createShellJobId(): string {
  return `shell-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
}

function getQCodeDir(name: string): string {
  const dir = join(getQCodeRoot(), name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getQCodeRoot(): string {
  return process.env.Q_CODE_HOME?.trim() || join(homedir(), '.q-code')
}

function appendJobIndex(job: ShellJob, sessionId = job.sessionId ?? 'default'): void {
  const file = join(getQCodeDir('shell-jobs'), `${sessionId}.index`)
  const { child: _child, outputFd: _outputFd, ...record } = job
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8')
}

function closeJobOutput(job: ShellJob): void {
  if (job.outputFd === undefined) return
  try {
    closeSync(job.outputFd)
  } catch {
    // best-effort cleanup
  }
  job.outputFd = undefined
}

function pruneCompletedShellJobs(): void {
  const completed = [...shellJobs.values()].filter((job) => job.status !== 'running')
  if (completed.length <= SHELL_COMPLETED_JOB_RETENTION) return

  completed.sort((a, b) => shellJobCompletedAt(a) - shellJobCompletedAt(b))
  const removeCount = completed.length - SHELL_COMPLETED_JOB_RETENTION
  for (const job of completed.slice(0, removeCount)) {
    closeJobOutput(job)
    shellJobs.delete(job.jobId)
  }
}

function shellJobCompletedAt(job: ShellJob): number {
  const timestamp = Date.parse(job.finishedAt ?? job.startedAt)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function formatJobStatus(job: ShellJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    command: job.command,
    ...(job.label ? { label: job.label } : {}),
    cwd: job.cwd,
    pid: job.pid,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.signal !== undefined ? { signal: job.signal } : {}),
    ...(job.durationMs !== undefined ? { durationMs: job.durationMs } : {}),
    bytes: currentJobBytes(job),
    outputFile: job.outputFile
  }
}

function readJobTail(job: ShellJob, fromOffset: number | undefined, maxBytes: number | undefined) {
  const offset = normalizeByteOffset(fromOffset)
  const limit = normalizeTailLimit(maxBytes)
  const totalBytes = currentJobBytes(job)
  if (!existsSync(job.outputFile)) {
    return { jobId: job.jobId, offset, nextOffset: offset, bytes: 0, totalBytes, eof: job.status !== 'running', text: '' }
  }
  if (offset >= totalBytes) {
    return {
      jobId: job.jobId,
      offset,
      nextOffset: offset,
      bytes: 0,
      totalBytes,
      eof: job.status !== 'running',
      status: job.status,
      text: ''
    }
  }

  const length = Math.min(limit, totalBytes - offset)
  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  const fd = openSync(job.outputFile, 'r')
  try {
    bytesRead = readSync(fd, buffer, 0, length, offset)
  } finally {
    closeSync(fd)
  }
  const nextOffset = offset + bytesRead
  return {
    jobId: job.jobId,
    offset,
    nextOffset,
    bytes: bytesRead,
    totalBytes,
    eof: nextOffset >= totalBytes && job.status !== 'running',
    status: job.status,
    text: buffer.subarray(0, bytesRead).toString('utf-8')
  }
}

function normalizeByteOffset(value: number | undefined): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function normalizeTailLimit(value: number | undefined): number {
  const n = Number(value ?? DEFAULT_TAIL_MAX_BYTES)
  const finite = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TAIL_MAX_BYTES
  return Math.min(Math.max(1, finite), 1024 * 1024)
}

function currentJobBytes(job: ShellJob): number {
  try {
    return statSync(job.outputFile).size
  } catch {
    return job.bytes
  }
}

function appendTail(value: string, chunk: string, maxChars: number): string {
  return (value + chunk).slice(-maxChars)
}

function appendHead(value: string, chunk: string, maxChars: number): string {
  if (value.length >= maxChars) return value
  return (value + chunk).slice(0, maxChars)
}

function looksInteractive(chunk: string): boolean {
  return /(\?\s*$|\(y\/n\)|password:\s*$|enter .+:\s*$|请输入|输入.+:)/i.test(chunk)
}

function createShellProgressEmitter(context: ToolExecutionContext, label: string) {
  let buffered = ''
  let lineCount = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const text = buffered.trimEnd()
    buffered = ''
    lineCount = 0
    if (!text) return
    context.onProgress?.({
      type: 'shell_output',
      text: `[${label}] ${text.slice(-2000)}`
    })
  }

  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(flush, 250)
    timer.unref()
  }

  return {
    push: (target: 'stdout' | 'stderr', chunk: string): void => {
      buffered += target === 'stderr' ? `[stderr] ${chunk}` : chunk
      lineCount += chunk.split(/\r\n|\r|\n/).length - 1
      if (lineCount >= 80) flush()
      else schedule()
    },
    flush
  }
}

function registerShellProcessCleanup(): void {
  if (shellProcessCleanupRegistered) return
  shellProcessCleanupRegistered = true
  const cleanup = () => {
    if (!shouldKillBackgroundOnExit()) return
    for (const job of shellJobs.values()) {
      if (job.status !== 'running') continue
      job.status = 'killed'
      job.finishedAt = new Date().toISOString()
      job.durationMs = Date.now() - Date.parse(job.startedAt)
      terminateProcessTree(job.pid)
      closeJobOutput(job)
      job.child = undefined
      appendJobIndex(job)
    }
    pruneCompletedShellJobs()
  }
  process.once('beforeExit', cleanup)
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
}

function shouldKillBackgroundOnExit(): boolean {
  if (process.env.Q_CODE_SHELL_KILL_BG_ON_EXIT !== undefined) {
    return !isFalseEnv(process.env.Q_CODE_SHELL_KILL_BG_ON_EXIT)
  }
  return readShellKillBackgroundSetting()
}

function readShellKillBackgroundSetting(): boolean {
  let result = false
  const files = [join(getQCodeRoot(), 'settings.json'), join(process.cwd(), '.q-code', 'settings.json')]
  for (const file of files) {
    try {
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
      const shell = asRecord(parsed)?.shell
      const value = asRecord(shell)?.killBackgroundOnExit
      if (typeof value === 'boolean') result = value
    } catch {
      // settings.json is best-effort for shell cleanup; invalid MCP config must
      // not break process shutdown.
    }
  }
  return result
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      terminateWindowsProcessTree(pid)
      return
    }
    process.kill(-pid, 'SIGTERM')
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }, 500).unref()
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

function terminateWindowsProcessTree(pid: number): void {
  try {
    const result = spawnSync('taskkill.exe', getWindowsProcessTreeKillArgs(pid), {
      stdio: 'ignore',
      windowsHide: true
    })
    if (result.error || result.status !== 0) killSingleProcess(pid)
  } catch {
    killSingleProcess(pid)
  }
}

function killSingleProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

function formatAbortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string' && reason.trim()) return reason
  return 'Aborted'
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
