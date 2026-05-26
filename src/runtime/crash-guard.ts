/**
 * 进程级崩溃保护：未捕获异常、未处理 Promise 拒绝与 SIGINT/SIGTERM/SIGHUP。
 *
 * 在退出前尽力：写入 mid-stream 标记、卸载 Ink、运行 cleanup、刷审计、
 * 写 JSON 崩溃报告到 `<Q_CODE_HOME>/crashes`。默认注册除非 `Q_CODE_CRASH_GUARD=false`。
 * 用户提示仅走裸 `stderr.write`，不依赖 TUI。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SessionStore } from '../session/store'
import type { TerminalRuntime } from '../terminal/runtime'
import { getAuditLogger, setCrashGuardOwnsSignalHandlers } from '../observability/audit'
import { isFalseEnv } from '../utils/env'

/** `installCrashGuard` 的配置与可测试注入点。 */
export interface CrashGuardOptions {
  sessionStore?: SessionStore
  terminal?: TerminalRuntime
  getTerminal?: () => TerminalRuntime | undefined
  cleanupHandlers: Array<() => Promise<void> | void>
  reportDir?: string
  version?: string
  register?: boolean
  getSnapshot?: () => Partial<CrashReport>
  stderr?: Pick<NodeJS.WriteStream, 'write'>
  exit?: (code: number) => never | void
  now?: () => Date
  writeReport?: (filePath: string, report: CrashReport) => void
  cleanupTimeoutMs?: number
  terminalRestoreTimeoutMs?: number
}

/** 已注册的处理句柄；`dispose` 卸载 process 监听器。 */
export interface CrashGuardHandle {
  handleUncaughtException: (error: unknown) => void
  handleUnhandledRejection: (reason: unknown) => void
  handleSignal: (signal: CrashSignal) => void
  dispose: () => void
}

/** 可优雅关闭的 POSIX 信号（Windows 不注册 SIGHUP）。 */
export type CrashSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'

/** 写入磁盘的崩溃报告 JSON 结构。 */
export interface CrashReport {
  version: string
  platform: NodeJS.Platform
  nodeVersion: string
  ts: string
  sessionId?: string
  cwd?: string
  modelName?: string
  agentMode?: string
  taskMode?: string
  lastUserPromptDigest?: string
  lastToolCall?: {
    name: string
    toolCallId?: string
  }
  activeTurnInFlight?: boolean
  asyncAgents?: Array<Record<string, unknown>>
  mcpServers?: Array<Record<string, unknown>>
  signal?: CrashSignal
  snapshotError?: SerializedError
  error: SerializedError
  memorySnapshot: NodeJS.MemoryUsage
}

/** 可 JSON 序列化的错误摘要。 */
export interface SerializedError {
  name: string
  message: string
  stack?: string
  code?: unknown
}

const FORCE_EXIT_CODES: Record<CrashSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 2000
const DEFAULT_TERMINAL_RESTORE_TIMEOUT_MS = 1000

let installed: CrashGuardHandle | undefined

/**
 * 安装全局崩溃/信号处理器（单例：新安装会先 dispose 旧句柄）。
 *
 * @param options.register - 为 false 时仅返回句柄，不挂到 process（测试用）
 * @returns 可手动调用或 `dispose` 的句柄
 */
export function installCrashGuard(options: CrashGuardOptions): CrashGuardHandle {
  const shouldRegister =
    options.register !== false && !isFalseEnv(process.env.Q_CODE_CRASH_GUARD)
  const stderr = options.stderr ?? process.stderr
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const now = options.now ?? (() => new Date())
  const reportDir = resolve(options.reportDir ?? defaultCrashReportDir())
  const writeReport = options.writeReport ?? defaultWriteReport
  let handling = false
  let lastSignal: CrashSignal | undefined
  let signalCount = 0

  const handleFatal = (kind: 'uncaughtException' | 'unhandledRejection', error: unknown) => {
    void runCrashShutdown({
      kind,
      error,
      options,
      stderr,
      exit,
      now,
      reportDir,
      writeReport,
      exitCode: 1,
      isAlreadyHandling: () => handling,
      markHandling: () => {
        handling = true
      }
    })
  }

  const handleSignal = (signal: CrashSignal) => {
    if (lastSignal === signal) signalCount++
    else {
      lastSignal = signal
      signalCount = 1
    }
    // 第二次相同信号：跳过清理，按 shell 惯例立即硬退出
    if (handling || signalCount >= 2) {
      exit(FORCE_EXIT_CODES[signal])
      return
    }
    void runCrashShutdown({
      kind: 'signal',
      error: new Error(`Received ${signal}`),
      signal,
      options,
      stderr,
      exit,
      now,
      reportDir,
      writeReport,
      exitCode: FORCE_EXIT_CODES[signal],
      isAlreadyHandling: () => handling,
      markHandling: () => {
        handling = true
      }
    })
  }

  const handle: CrashGuardHandle = {
    handleUncaughtException: (error) => handleFatal('uncaughtException', error),
    handleUnhandledRejection: (reason) => handleFatal('unhandledRejection', reason),
    handleSignal,
    dispose: () => {
      process.off('uncaughtException', handle.handleUncaughtException)
      process.off('unhandledRejection', handle.handleUnhandledRejection)
      process.off('SIGINT', handle.handleSignal as NodeJS.SignalsListener)
      process.off('SIGTERM', handle.handleSignal as NodeJS.SignalsListener)
      if (process.platform !== 'win32') {
        process.off('SIGHUP', handle.handleSignal as NodeJS.SignalsListener)
      }
      if (installed === handle) {
        installed = undefined
        setCrashGuardOwnsSignalHandlers(false)
      }
    }
  }

  if (shouldRegister) {
    const previous = installed
    if (previous && previous !== handle) previous.dispose()
    setCrashGuardOwnsSignalHandlers(true)
    process.on('uncaughtException', handle.handleUncaughtException)
    process.on('unhandledRejection', handle.handleUnhandledRejection)
    process.on('SIGINT', handle.handleSignal as NodeJS.SignalsListener)
    process.on('SIGTERM', handle.handleSignal as NodeJS.SignalsListener)
    if (process.platform !== 'win32') {
      process.on('SIGHUP', handle.handleSignal as NodeJS.SignalsListener)
    }
    installed = handle
  }

  return handle
}

async function runCrashShutdown(args: {
  kind: 'uncaughtException' | 'unhandledRejection' | 'signal'
  error: unknown
  signal?: CrashSignal
  options: CrashGuardOptions
  stderr: Pick<NodeJS.WriteStream, 'write'>
  exit: (code: number) => never | void
  now: () => Date
  reportDir: string
  writeReport: (filePath: string, report: CrashReport) => void
  exitCode: number
  isAlreadyHandling: () => boolean
  markHandling: () => void
}): Promise<void> {
  if (args.isAlreadyHandling()) {
    args.exit(args.exitCode)
    return
  }
  args.markHandling()

  const baseSnapshot = safeGetSnapshot(args.options)
  if (baseSnapshot.activeTurnInFlight && args.options.sessionStore) {
    try {
      args.options.sessionStore.append({ role: 'assistant', content: '[crashed mid-stream]' })
    } catch {
      // Best-effort crash marker. The crash report still carries activeTurnInFlight.
    }
  }

  await restoreTerminal(safeGetTerminal(args.options), args.stderr, args.options)

  for (const handler of args.options.cleanupHandlers) {
    await withTimeout(
      Promise.resolve().then(handler),
      args.options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
    )
  }

  const report = buildCrashReport({
    snapshot: baseSnapshot,
    error: args.error,
    signal: args.signal,
    version: args.options.version ?? 'unknown',
    now: args.now
  })
  const reportPath = join(args.reportDir, formatCrashReportName(report))

  try {
    const auditLogger = getAuditLogger()
    auditLogger.emit(
      'error',
      {
        where: 'crash.guard',
        kind: args.kind,
        ...(args.signal ? { signal: args.signal } : {}),
        message: report.error.message,
        reportPath
      },
      {
        ...(report.sessionId ? { sessionId: report.sessionId } : {}),
        ...(report.cwd ? { cwd: report.cwd } : {})
      }
    )
    await withTimeout(auditLogger.flush(), args.options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS)
  } catch {
    // Audit must never block the final crash report.
  }

  try {
    args.writeReport(reportPath, report)
  } catch (error) {
    args.stderr.write(`\n[crash-guard] 崩溃报告写入失败: ${formatUnknownError(error)}\n`)
  }

  args.stderr.write(formatCrashMessage(report.error, reportPath))
  args.exit(args.exitCode)
}

function buildCrashReport(args: {
  snapshot: Partial<CrashReport>
  error: unknown
  signal: CrashSignal | undefined
  version: string
  now: () => Date
}): CrashReport {
  const ts = args.now().toISOString()
  return {
    version: args.version,
    platform: process.platform,
    nodeVersion: process.version,
    ts,
    ...args.snapshot,
    ...(args.signal ? { signal: args.signal } : {}),
    error: serializeError(args.error),
    memorySnapshot: process.memoryUsage()
  }
}

async function restoreTerminal(
  terminal: TerminalRuntime | undefined,
  stderr: Pick<NodeJS.WriteStream, 'write'>,
  options: CrashGuardOptions
): Promise<void> {
  if (terminal) {
    try {
      terminal.instance.unmount()
      await withTimeout(
        terminal.instance.waitUntilExit(),
        options.terminalRestoreTimeoutMs ?? DEFAULT_TERMINAL_RESTORE_TIMEOUT_MS
      )
    } catch {
      // Terminal restore continues with raw escape sequences below.
    }
  }
  stderr.write('\u001b[?25h\u001b[?1049l\u001b[0m')
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown }
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(record.code !== undefined ? { code: record.code } : {})
    }
  }
  return {
    name: 'NonError',
    message: typeof error === 'string' ? error : safeStringify(error)
  }
}

function formatCrashReportName(report: CrashReport): string {
  const session = sanitizeFilePart(report.sessionId || 'no-session')
  const ts = report.ts.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `crash-${session}-${ts}.json`
}

function formatCrashMessage(error: SerializedError, reportPath: string): string {
  const code = error.code ? `${String(error.code)} ` : ''
  return [
    '',
    '✖ q-code 异常退出',
    '',
    `错误: ${code}${error.message}`,
    `报告: ${reportPath}`,
    '',
    '可执行以下操作:',
    '  - 重启 q-code 并用 --continue 恢复会话',
    '  - 运行 q-code audit tail 查看崩溃前后的审计事件',
    '  - 提交问题: https://github.com/v833/q-code/issues/new',
    '    （请附上报告文件，注意检查是否含敏感信息）',
    ''
  ].join('\n')
}

function defaultCrashReportDir(): string {
  const qCodeHome = process.env.Q_CODE_HOME?.trim() || join(homedir(), '.q-code')
  return join(qCodeHome, 'crashes')
}

function defaultWriteReport(filePath: string, report: CrashReport): void {
  const dir = dirname(filePath)
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
}

function sanitizeFilePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
  return sanitized || 'unknown'
}

function safeGetSnapshot(options: CrashGuardOptions): Partial<CrashReport> {
  try {
    return options.getSnapshot?.() ?? {}
  } catch (error) {
    return { snapshotError: serializeError(error) }
  }
}

function safeGetTerminal(options: CrashGuardOptions): TerminalRuntime | undefined {
  try {
    return options.getTerminal?.() ?? options.terminal
  } catch {
    return options.terminal
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      }
    )
  })
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 对用户提示等敏感字段做 SHA-256 摘要（写入报告时脱敏用）。
 *
 * @param text - 原始文本
 */
export function sha256ForCrashGuard(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
