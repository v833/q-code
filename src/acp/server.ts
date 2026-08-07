/** ACP v1 Agent 服务器：把外部产品的 session/prompt 映射到 q-code headless Agent。 */
import { Readable, Writable } from 'node:stream'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentContext,
  type AgentConnection,
  type AgentApp,
  type ContentBlock,
  type PromptResponse,
  type PromptRequest,
  type SessionNotification
} from '@agentclientprotocol/sdk'
import { runMain } from '../cli/main'
import { formatExecError } from '../cli/exec-cli'
import type { ConversationUsage } from '../cli/conversation-events'
import { createSessionId, SessionStore } from '../session/store'
import { convertAcpPromptContent } from './content'

const MAX_ACP_OUTPUT_CHARS = 20_000

export interface RunAcpServerOptions {
  cwd: string
  packageVersion: string
  signal?: AbortSignal
  onDiagnostic?: (text: string) => void
}

interface AcpSessionState {
  sessionId: string
  cwd: string
  client: AgentContext
  promptController?: AbortController
  promptPromise?: Promise<unknown>
  cancelRequested?: boolean
  closed?: boolean
}

/** 在当前 stdio 上运行一个 ACP v1 Agent 连接。 */
export async function runAcpServer(options: RunAcpServerOptions): Promise<void> {
  const sessions = new Map<string, AcpSessionState>()
  let connection: AgentConnection | undefined

  const app = createAgentApp(options, sessions)
    .onConnect((nextConnection) => {
      connection = nextConnection
    })

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  )
  connection = app.connect(stream)

  const closeFromSignal = (): void => {
    connection?.close(new Error('ACP 连接已被取消'))
  }
  const closeFromInput = (): void => {
    connection?.close(new Error('ACP stdin 已关闭'))
  }
  options.signal?.addEventListener('abort', closeFromSignal, { once: true })
  process.stdin.once('end', closeFromInput)

  try {
    await connection.closed
  } finally {
    options.signal?.removeEventListener('abort', closeFromSignal)
    process.stdin.removeListener('end', closeFromInput)
    await closeSessions(sessions)
  }
}

function createAgentApp(
  options: RunAcpServerOptions,
  sessions: Map<string, AcpSessionState>
): AgentApp {
  let promptTail: Promise<void> = Promise.resolve()
  const schedule = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = promptTail.then(operation, operation)
    promptTail = result.then(() => undefined, () => undefined)
    return result
  }

  return agent({ name: 'q-code' })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'q-code', version: options.packageVersion },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: false },
        sessionCapabilities: { close: {} }
      },
      _meta: {
        qCode: { transport: 'stdio', workspace: options.cwd }
      }
    }))
    .onRequest(methods.agent.session.new, ({ params, client }) => {
      validateSessionRequest(params, options.cwd)
      const sessionId = createSessionId()
      new SessionStore({ cwd: options.cwd, sessionId })
      sessions.set(sessionId, { sessionId, cwd: options.cwd, client })
      return { sessionId }
    })
    .onRequest(methods.agent.session.prompt, ({ params, client, signal }) => {
      const session = requireSession(sessions, params.sessionId)
      if (session.closed) throw new Error(`ACP session 已关闭: ${params.sessionId}`)
      if (session.promptPromise) throw new Error(`ACP session 正在处理另一个 prompt: ${params.sessionId}`)
      const scheduled = schedule(() => runPrompt({ session, params, client, signal, options }))
      session.promptPromise = scheduled
      void scheduled.then(
        () => clearPromptPromise(session, scheduled),
        () => clearPromptPromise(session, scheduled)
      )
      return scheduled
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      const session = sessions.get(params.sessionId)
      if (!session) return
      if (!session.promptPromise) return
      session.cancelRequested = true
      session.promptController?.abort(new Error('ACP session/cancel'))
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const session = sessions.get(params.sessionId)
      if (!session) return {}
      session.closed = true
      session.cancelRequested = true
      session.promptController?.abort(new Error('ACP session/close'))
      await session.promptPromise?.catch(() => undefined)
      sessions.delete(params.sessionId)
      return {}
    })
}

async function runPrompt(args: {
  session: AcpSessionState
  params: PromptRequest
  client: AgentContext
  signal: AbortSignal
  options: RunAcpServerOptions
}): Promise<PromptResponse> {
  const { session, params, client, signal, options } = args
  const input = convertAcpPromptContent(params, session.cwd)
  const controller = new AbortController()
  session.promptController = controller
  if (session.cancelRequested || session.closed) {
    controller.abort(new Error('ACP prompt 已取消'))
  }
  const abortFromRequest = (): void => controller.abort(signal.reason ?? new Error('ACP 请求已取消'))
  signal.addEventListener('abort', abortFromRequest, { once: true })

  let updateTail: Promise<void> = Promise.resolve()
  let sawText = false
  const messageId = randomUUID()
  let completedUsage: ConversationUsage | undefined
  const enqueueUpdate = (update: SessionNotification['update']): void => {
    updateTail = updateTail
      .then(() => client.notify(methods.client.session.update, {
        sessionId: session.sessionId,
        update
      }))
      .catch((error) => {
        options.onDiagnostic?.(`ACP session/update 发送失败: ${formatExecError(error)}`)
      })
  }

  return (async () => {
    try {
      const result = await runMain({
        packageVersion: options.packageVersion,
        argv: ['--session', session.sessionId],
        headless: {
          prompt: input.prompt,
          imageAttachments: input.imageAttachments,
          signal: controller.signal,
          onDiagnostic: options.onDiagnostic,
          onText: (text) => {
            sawText = true
            enqueueUpdate({
              sessionUpdate: 'agent_message_chunk',
              messageId,
              content: { type: 'text', text }
            })
          },
          onReasoning: (text) => {
            enqueueUpdate({
              sessionUpdate: 'agent_thought_chunk',
              messageId,
              content: { type: 'text', text }
            })
          },
          onEvent: (event) => {
            if (event.type === 'tool_started') {
              enqueueUpdate({
                sessionUpdate: 'tool_call',
                toolCallId: event.toolCallId,
                title: event.name,
                name: event.name,
                kind: toolKind(event.name),
                status: 'in_progress',
                rawInput: event.input
              })
            } else if (event.type === 'tool_completed') {
              enqueueUpdate({
                sessionUpdate: 'tool_call_update',
                toolCallId: event.toolCallId,
                status: event.isError ? 'failed' : 'completed',
                rawOutput: previewValue(event.output)
              })
            } else if (event.type === 'assistant_completed' && !sawText && event.text) {
              sawText = true
              enqueueUpdate({
                sessionUpdate: 'agent_message_chunk',
                messageId: event.messageId,
                content: { type: 'text', text: event.text }
              })
            } else if (event.type === 'turn_completed') {
              completedUsage = event.usage
            }
          }
        }
      })
      if (!result) throw new Error('ACP prompt 未返回运行结果')
      await updateTail
      completedUsage = completedUsage ?? result.usage
      const usage = completedUsage
      return {
        stopReason: 'end_turn' as const,
        usage: {
          totalTokens: usage.inputTokens + usage.outputTokens,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cachedInputTokens !== undefined
            ? { cachedReadTokens: usage.cachedInputTokens }
            : {})
        }
      }
    } catch (error) {
      await updateTail
      if (controller.signal.aborted) return { stopReason: 'cancelled' as const }
      throw new Error(formatExecError(error))
    } finally {
      signal.removeEventListener('abort', abortFromRequest)
      if (session.promptController === controller) session.promptController = undefined
      session.cancelRequested = false
    }
  })()
}

function clearPromptPromise(session: AcpSessionState, promptPromise: Promise<unknown>): void {
  if (session.promptPromise === promptPromise) session.promptPromise = undefined
}

function validateSessionRequest(
  params: { cwd: string; additionalDirectories?: string[]; mcpServers: unknown[] },
  serverCwd: string
): void {
  if (!isAbsolutePath(params.cwd) || normalizeForCompare(params.cwd) !== normalizeForCompare(serverCwd)) {
    throw new Error(`ACP session cwd 必须等于当前 q-code 工作目录: ${serverCwd}`)
  }
  if (params.additionalDirectories && params.additionalDirectories.length > 0) {
    throw new Error('ACP additionalDirectories 暂未支持')
  }
  if (params.mcpServers.length > 0) {
    throw new Error('ACP session mcpServers 暂未支持，请使用 q-code settings.json 配置 MCP')
  }
}

function requireSession(
  sessions: Map<string, AcpSessionState>,
  sessionId: string
): AcpSessionState {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`ACP session 不存在: ${sessionId}`)
  return session
}

async function closeSessions(sessions: Map<string, AcpSessionState>): Promise<void> {
  for (const session of sessions.values()) session.promptController?.abort(new Error('ACP 连接已关闭'))
  await Promise.allSettled([...sessions.values()].map((session) => session.promptPromise).filter(Boolean))
  sessions.clear()
}

function toolKind(name: string): 'read' | 'edit' | 'search' | 'execute' | 'fetch' | 'other' {
  if (name === 'write_file' || name === 'edit_file') return 'edit'
  if (name === 'f' || name.startsWith('f_')) return 'execute'
  if (name === 'grep' || name === 'glob' || name === 'list_directory') return 'search'
  if (name === 'read_file') return 'read'
  if (name === 'safe_fetch') return 'fetch'
  return 'other'
}

function previewValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= MAX_ACP_OUTPUT_CHARS
      ? value
      : `${value.slice(0, MAX_ACP_OUTPUT_CHARS - 80)}\n... [ACP 输出已截断] ...`
  }
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return String(value)
    if (serialized.length <= MAX_ACP_OUTPUT_CHARS) return value
    return `${serialized.slice(0, MAX_ACP_OUTPUT_CHARS - 80)}\n... [ACP 输出已截断] ...`
  } catch {
    return String(value)
  }
}

function isAbsolutePath(value: string): boolean {
  return resolve(value) === value || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function normalizeForCompare(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
