/**
 * 进程内 SDK 入口：以库的方式驱动 q-code 的单个 Agent 会话。
 *
 * 一个 Node 进程只应创建一个 Session，且工作目录在创建后不可变更：
 * 运行时配置、审计日志、MCP 与崩溃保护均是进程级单例。多项目/多租户
 * 并发应由宿主用子进程隔离。本入口不加载 CLI bootstrap，导入不会启动交互界面。
 */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ImageAttachment } from '../attachments'
import type { ConversationEvent } from '../cli/conversation-events'
import type {
  ConversationTurnInput,
  ConversationTurnResult,
} from '../cli/conversation-runtime'
import { applyRuntimeConfig } from '../config/runtime-config'
import { getPackageVersion } from '../runtime/cli-info'

/** 创建会话的选项。 */
export interface QCodeSessionOptions {
  /** 会话工作目录；进程内唯一，创建后不可变更。 */
  cwd: string
  /** 默认模型名；单轮可用 `run()` 的 `model` 覆盖。 */
  model?: string
  /** 恢复已有会话 id。 */
  sessionId?: string
  /** 不写 transcript/metadata，仅保留在进程内。 */
  ephemeral?: boolean
  /** 只读模式下只暴露只读工具。 */
  sandboxMode?: 'read-only' | 'workspace-write'
  onEvent?: (event: ConversationEvent) => void
  onText?: (text: string) => void
  onDiagnostic?: (text: string) => void
  signal?: AbortSignal
}

/** 单轮输入选项。 */
export interface QCodeTurnOptions {
  images?: ImageAttachment[]
  model?: string
  allowedToolNames?: Set<string>
  /** 为 false 时允许只调用工具、不输出最终文本的轮次。 */
  requireFinalText?: boolean
}

/** 单轮完成结果。 */
export interface QCodeTurnResult extends ConversationTurnResult {
  sessionId: string
}

/** 进程内 Agent 会话。 */
export interface QCodeSession {
  readonly sessionId: string
  run(prompt: string, options?: QCodeTurnOptions): Promise<QCodeTurnResult>
  /** 取消进行中的轮次并终止会话。 */
  abort(reason?: unknown): void
  /** 关闭会话；可重复调用。 */
  close(): Promise<void>
}

/** 创建一个串行、可取消的 q-code 会话。 */
export async function createQCodeSession(options: QCodeSessionOptions): Promise<QCodeSession> {
  const cwd = resolve(options.cwd)
  const info = await stat(cwd).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`工作目录不存在或不是文件夹: ${cwd}`)
  if (resolve(process.cwd()) !== cwd) process.chdir(cwd)
  applyRuntimeConfig(cwd)

  const { runMain } = await import('../cli/main')
  const turns = new TurnQueue()
  const abortController = new AbortController()
  const ready = createDeferred<string>()
  let sessionId = ''
  let pendingTurn: Deferred<QCodeTurnResult> | undefined
  let closed = false

  const fail = (error: unknown): void => {
    const normalized = error instanceof Error ? error : new Error(String(error))
    closed = true
    turns.close(normalized)
    ready.reject(normalized)
    pendingTurn?.reject(normalized)
    pendingTurn = undefined
  }

  const runner = runMain({
    packageVersion: getPackageVersion(),
    argv: options.sessionId ? ['--session', options.sessionId] : [],
    headless: {
      turns,
      ...(options.model ? { modelName: options.model } : {}),
      ...(options.sandboxMode ? { sandboxMode: options.sandboxMode } : {}),
      ...(options.ephemeral ? { ephemeral: true } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.onText ? { onText: options.onText } : {}),
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
      signal: abortController.signal,
      onSessionReady: (id) => {
        sessionId = id
        ready.resolve(id)
      },
      onTurnResult: (result) => {
        const deferred = pendingTurn
        pendingTurn = undefined
        deferred?.resolve(result)
      },
    },
  }).catch(fail)

  const handleExternalAbort = (): void => {
    abortController.abort(options.signal?.reason)
  }
  options.signal?.addEventListener('abort', handleExternalAbort, { once: true })

  try {
    await ready.promise
  } catch (error) {
    options.signal?.removeEventListener('abort', handleExternalAbort)
    throw error
  }

  return {
    get sessionId() {
      return sessionId
    },
    async run(prompt, turnOptions = {}) {
      if (closed) throw new Error('QCodeSession 已关闭')
      if (pendingTurn) throw new Error('上一次 run 尚未完成')
      const deferred = createDeferred<QCodeTurnResult>()
      pendingTurn = deferred
      const modelName = turnOptions.model ?? options.model
      try {
        turns.push({
          prompt,
          imageAttachments: turnOptions.images ?? [],
          ...(modelName ? { modelName } : {}),
          ...(turnOptions.allowedToolNames ? { allowedToolNames: turnOptions.allowedToolNames } : {}),
          ...(turnOptions.requireFinalText === false ? { requireFinalText: false } : {}),
        })
        return await deferred.promise
      } finally {
        if (pendingTurn === deferred) pendingTurn = undefined
      }
    },
    abort(reason) {
      abortController.abort(reason)
    },
    async close() {
      if (closed) return
      closed = true
      options.signal?.removeEventListener('abort', handleExternalAbort)
      abortController.abort(new Error('QCodeSession 正在关闭'))
      turns.close()
      await runner
    },
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 供 runMain 的 headless 循环消费的输入流。 */
class TurnQueue implements AsyncIterable<ConversationTurnInput>, AsyncIterator<ConversationTurnInput> {
  private readonly buffered: ConversationTurnInput[] = []
  private waiter: {
    resolve: (result: IteratorResult<ConversationTurnInput>) => void
    reject: (error: Error) => void
  } | undefined
  private terminalError: Error | undefined
  private done = false

  push(input: ConversationTurnInput): void {
    if (this.done) throw new Error('QCodeSession 已关闭')
    if (this.waiter) {
      const { resolve } = this.waiter
      this.waiter = undefined
      resolve({ value: input, done: false })
      return
    }
    this.buffered.push(input)
  }

  close(error?: Error): void {
    if (this.done) return
    this.done = true
    this.terminalError = error
    this.buffered.length = 0
    const waiter = this.waiter
    this.waiter = undefined
    if (!waiter) return
    if (error) waiter.reject(error)
    else waiter.resolve({ value: undefined, done: true })
  }

  next(): Promise<IteratorResult<ConversationTurnInput>> {
    const input = this.buffered.shift()
    if (input) return Promise.resolve({ value: input, done: false })
    if (this.done) {
      return this.terminalError
        ? Promise.reject(this.terminalError)
        : Promise.resolve({ value: undefined, done: true })
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<ConversationTurnInput> {
    return this
  }
}
