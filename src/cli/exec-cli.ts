/**
 * Codex 兼容无头 CLI：处理 cwd/config 顺序、stdin、图片、会话恢复、JSONL 与退出码。
 */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  ExecArgsError,
  composeExecPrompt,
  parseExecArgs,
  type ExecArgs,
} from './exec-args'
import { mapConversationEventToCodex, serializeCodexEvent } from './codex-jsonl'
import type { ConversationEvent } from './conversation-events'
import { formatCliVersion, formatExecHelp } from '../runtime/cli-info'
import type { StartupTrace } from '../runtime/startup-trace'

const SECRET_ENV_NAMES = [
  'OPENAI_API_KEY',
  'SUMMARY_API_KEY',
  'LANGFUSE_SECRET_KEY',
  'Q_CODE_INFRA_TOKEN',
  'Q_CODE_GITLAB_TOKEN',
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
] as const

/** exec 入口依赖，由薄 bootstrap 注入 runtime config 加载时机。 */
export interface RunExecCliOptions {
  argv: string[]
  packageVersion: string
  startupTrace?: StartupTrace
  applyRuntimeConfig(): Promise<void>
}

/** 运行一次 Codex 兼容 exec，并返回进程退出码。 */
export async function runExecCli(options: RunExecCliOptions): Promise<number> {
  const jsonRequested = options.argv.includes('--json')
  const abortController = new AbortController()
  let pipeClosed = false
  let failureEventEmitted = false
  let turnEventStarted = false
  let pendingTurnCompleted: ConversationEvent | undefined

  const handleStdoutError = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') return
    pipeClosed = true
    abortController.abort(error)
  }
  const handleSigint = (): void => {
    abortController.abort(new Error('exec 已由 SIGINT 取消'))
  }
  process.stdout.on('error', handleStdoutError)
  process.once('SIGINT', handleSigint)

  let parsed: ExecArgs | undefined
  try {
    parsed = parseExecArgs(options.argv)
    if (parsed.action === 'help' || parsed.action === 'resume-help') {
      writeStdout(`${formatExecHelp(options.packageVersion, parsed.action === 'resume-help')}\n`)
      return 0
    }
    if (parsed.action === 'version') {
      writeStdout(`${formatCliVersion(options.packageVersion)}\n`)
      return 0
    }

    const cwd = await resolveExecCwd(parsed.cwd)
    process.chdir(cwd)
    await options.applyRuntimeConfig()

    const stdinPiped = process.stdin.isTTY !== true
    const stdin = stdinPiped ? await readStdin() : ''
    const prompt = composeExecPrompt(parsed.prompt, stdin, stdinPiped)

    const [attachmentsModule, sessionModule, atomicWriteModule, mainModule] = await Promise.all([
      import('../attachments'),
      import('../session/store'),
      import('../utils/atomic-write'),
      import('./main'),
    ])
    const imageAttachments = await Promise.all(
      parsed.images.map((image) => attachmentsModule.prepareImageAttachmentAsync(image, {
        cwd,
        source: 'path',
      })),
    )

    const sessionId = resolveResumeSession(parsed, cwd, sessionModule)
    const runtimeArgv = sessionId ? ['--session', sessionId] : []

    const publish = (event: ConversationEvent): void => {
      if (event.type === 'turn_started') turnEventStarted = true
      if (event.type === 'turn_failed' || event.type === 'runtime_error') {
        failureEventEmitted = true
      }
      if (event.type === 'turn_completed') {
        pendingTurnCompleted = event
        return
      }
      if (!parsed?.json || pipeClosed) return
      writeStdout(serializeCodexEvent(mapConversationEventToCodex(event)))
    }

    const result = await mainModule.runMain({
      packageVersion: options.packageVersion,
      argv: runtimeArgv,
      startupTrace: options.startupTrace,
      headless: {
        prompt,
        imageAttachments,
        ...(parsed.model ? { modelName: parsed.model } : {}),
        sandboxMode: parsed.sandbox,
        ephemeral: parsed.ephemeral,
        onEvent: publish,
        onDiagnostic: (text) => writeStderr(text),
        signal: abortController.signal,
      },
    })
    if (!result) throw new Error('exec 未返回运行结果')

    if (parsed.outputLastMessage) {
      await atomicWriteModule.writeTextAtomic(resolve(cwd, parsed.outputLastMessage), result.finalText)
    }
    if (pendingTurnCompleted && parsed.json && !pipeClosed) {
      writeStdout(serializeCodexEvent(mapConversationEventToCodex(pendingTurnCompleted)))
    }
    if (!parsed.json && !pipeClosed) writeStdout(`${result.finalText}\n`)
    return 0
  } catch (error) {
    if (pipeClosed) return 0
    if (abortController.signal.aborted) return 130

    const message = formatExecError(error)
    const useJson = parsed?.json ?? jsonRequested
    if (useJson && !failureEventEmitted) {
      writeStdout(serializeCodexEvent(turnEventStarted
        ? { type: 'turn.failed', error: { message } }
        : { type: 'error', message }))
    } else if (!useJson) {
      writeStderr(message)
    }
    return error instanceof ExecArgsError ? error.exitCode : 1
  } finally {
    process.stdout.removeListener('error', handleStdoutError)
    process.removeListener('SIGINT', handleSigint)
  }
}

async function resolveExecCwd(value: string | undefined): Promise<string> {
  const cwd = resolve(value ?? process.cwd())
  let info
  try {
    info = await stat(cwd)
  } catch {
    throw new ExecArgsError(`工作目录不存在: ${cwd}`)
  }
  if (!info.isDirectory()) throw new ExecArgsError(`工作目录不是文件夹: ${cwd}`)
  return cwd
}

function resolveResumeSession(
  args: ExecArgs,
  cwd: string,
  sessionModule: typeof import('../session/store'),
): string | undefined {
  if (args.action !== 'resume') return undefined
  if (args.resumeLast) {
    const latest = sessionModule.listProjectSessionsFast({ cwd })[0]
    if (!latest) throw new ExecArgsError('当前项目没有可恢复的 session')
    return latest.sessionId
  }

  const sessionId = args.sessionId
  if (!sessionId || !sessionModule.getSessionSummary(sessionId, { cwd })) {
    throw new ExecArgsError(`当前项目不存在 session: ${sessionId ?? '(empty)'}`)
  }
  return sessionId
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf-8')
  let content = ''
  for await (const chunk of process.stdin) content += chunk
  return content
}

function writeStdout(text: string): void {
  process.stdout.write(text)
}

function writeStderr(text: string): void {
  const normalized = text.trimEnd()
  if (normalized) process.stderr.write(`${normalized}\n`)
}

/** 把 exec 错误压缩为不含已知密钥和完整 endpoint 的用户可见摘要。 */
export function formatExecError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const name of SECRET_ENV_NAMES) {
    const secret = env[name]?.trim()
    if (secret && secret.length >= 8) message = message.replaceAll(secret, '[REDACTED]')
  }
  message = message
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[ _-]?key|access[ _-]?token|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
  return redactErrorUrls(message)
}

function redactErrorUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    const trailing = raw.match(/[),.;]+$/)?.[0] ?? ''
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw
    try {
      return `${new URL(candidate).origin}${trailing}`
    } catch {
      return '[REDACTED_ENDPOINT]'
    }
  })
}
