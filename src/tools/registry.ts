/**
 * 内置工具注册表：定义 ToolDefinition、Plan 模式可见性、并发锁，并将执行包装进 Hooks 与审计。
 */
import { jsonSchema } from 'ai'
import { fmtLockAcquire } from '../utils/logger'
import {
  createPostToolUseEvent,
  createPreToolUseEvent,
  type HookAgentContext,
  type HookRunner
} from '../hooks'
import {
  auditContext,
  createToolCallPayload,
  createToolResultPayload,
  getAuditLogger,
  safeStringify
} from '../observability/audit'

/** 工具对上下文的预估成本，用于 JIT 摘要分组。 */
export type ToolContextCost = 'low' | 'medium' | 'high'

/** 工具返回内容的语义形态，用于 JIT 摘要与截断策略提示。 */
export type ToolResultShape =
  | 'paths'
  | 'lines'
  | 'file'
  | 'command-output'
  | 'web'
  | 'state'
  | 'meta'
  | 'summary'
  | 'mutation'
  | 'agent-report'
  | 'unknown'

/** 内置/自定义/MCP 工具的统一描述与执行入口。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  allowInPlanMode?: boolean
  isEnabled?: () => boolean
  maxResultChars?: number
  execute: (input: any, context: ToolExecutionContext) => Promise<ToolExecutionOutput> | ToolExecutionOutput
  shouldDefer?: boolean
  searchHint?: string
  contextCost?: ToolContextCost
  resultShape?: ToolResultShape
  jitHint?: string
}

/** Agent Teams 队友身份，供 SendMessage 等工具解析发送方。 */
export interface TeammateIdentity {
  /** 队友显示名（非 agentId），例如 "backend"。 */
  agentName: string
  /** 当前活跃团队名，与 TeamFile.name 一致。 */
  teamName: string
}

/** 工具 execute 的原始返回值，可为任意值或结构化信封。 */
export type ToolExecutionOutput = unknown | ToolResultEnvelope

/** 结构化工具结果：ok/content/error 供 registry 统一渲染与截断。 */
export interface ToolResultEnvelope {
  ok: boolean
  content?: unknown
  error?: string
  code?: string
  metadata?: Record<string, unknown>
}

/** 工具执行过程中的进度事件，经 onProgress 上报给 TUI。 */
export interface ToolProgressEvent {
  type: string
  text?: string
  toolName?: string
  toolCallId?: string
  input?: unknown
  metadata?: Record<string, unknown>
}

/** 单次工具调用时的运行时上下文（cwd、会话、Hooks、队友身份等）。 */
export interface ToolExecutionContext {
  cwd: string
  abortSignal?: AbortSignal
  sessionId?: string
  hooks?: HookRunner
  agent?: HookAgentContext
  onProgress?: (event: ToolProgressEvent) => void
  /**
   * Set when the tool runs inside a named teammate's loop (Agent Teams).
   * Tools like SendMessage use it to resolve the sender's identity;
   * absent → the call is coming from the team lead's main session.
   */
  teammateIdentity?: TeammateIdentity
}

/** ToolRegistry 构造选项。 */
export interface ToolRegistryOptions {
  cwd?: string
  quiet?: boolean
}

/** toAISDKFormat 输出形态选项。 */
export interface ToolRegistryFormatOptions {
  resultEnvelope?: boolean
}

/** 工具可见性模式：normal 为常规；plan 仅暴露只读与显式允许的工具。 */
export type ToolVisibilityMode = 'normal' | 'plan'

// Tool outputs are capped before they enter the model context. The default is
// intentionally high enough for normal file/search work; noisy integrations
// such as MCP tools can still opt into a smaller per-tool limit.
const DEFAULT_MAX_RESULT_CHARS = 100000

const COST_ORDER: ToolContextCost[] = ['low', 'medium', 'high']
const COST_LABELS: Record<ToolContextCost, string> = {
  low: '低成本',
  medium: '中成本',
  high: '高成本'
}

const RESULT_SHAPE_LABELS: Record<ToolResultShape, string> = {
  paths: '路径列表',
  lines: '匹配行',
  file: '文件内容',
  'command-output': '命令输出',
  web: '网页/外部内容',
  state: '状态',
  meta: '元信息',
  summary: '摘要',
  mutation: '写入/变更结果',
  'agent-report': '子 Agent 报告',
  unknown: '未知形态'
}

const COST_SUMMARY_MAX_TOOLS_PER_BUCKET = 10

/**
 * 集中注册工具、按模式过滤可见性，并将 execute 包装为 AI SDK 格式（含锁、Hooks、审计）。
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private visibilityMode: ToolVisibilityMode = 'normal'
  private cwd: string
  private quiet: boolean

  private exclusiveLock = false
  private concurrentCount = 0
  private waitQueue: Array<() => void> = []

  private discoveredTools = new Set<string>()

  constructor(options: ToolRegistryOptions = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.quiet = options.quiet === true
  }

  setCwd(cwd: string): void {
    this.cwd = cwd
  }

  getCwd(): string {
    return this.cwd
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet
  }

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  unregisterByPrefix(prefix: string): number {
    let removed = 0
    for (const name of Array.from(this.tools.keys())) {
      if (!name.startsWith(prefix)) continue
      this.tools.delete(name)
      this.discoveredTools.delete(name)
      removed++
    }
    return removed
  }

  setMode(mode: ToolVisibilityMode): void {
    this.visibilityMode = mode
  }

  getMode(): ToolVisibilityMode {
    return this.visibilityMode
  }

  async closeAllMCP(): Promise<void> {
    // MCP connections are owned by src/mcp/client.ts. This method remains as
    // a compatibility no-op for older call sites.
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  getVisibleTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => isToolVisibleInMode(tool, this.visibilityMode))
  }

  getActiveTools(): ToolDefinition[] {
    return this.getVisibleTools().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false
      }
      return true
    })
  }

  getDeferredToolSummary(): string {
    const deferred = this.getVisibleTools().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name)
    })

    if (deferred.length === 0) return ''

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : ''
      return `  - ${t.name}${hint}`
    })

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim()
    const results: ToolDefinition[] = []

    // 支持逗号分隔的多个工具名，如 "mcp__github__list_issues,mcp__github__search_repositories"
    const names = q.includes(',')
      ? q
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      : [q]

    for (const name of names) {
      const tool = this.tools.get(name)
      if (tool && tool.name !== 'tool_search' && isToolVisibleInMode(tool, this.visibilityMode)) {
        results.push(tool)
        this.discoveredTools.add(tool.name)
      }
    }

    return results
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0
    let deferred = 0

    for (const tool of this.getVisibleTools()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }).length
      const tokens = Math.ceil(schemaSize / 4)

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens
      } else {
        active += tokens
      }
    }

    return { active, deferred, total: active + deferred }
  }

  getJitToolSummary(): string {
    const buckets = new Map<ToolContextCost, ToolDefinition[]>()
    for (const cost of COST_ORDER) buckets.set(cost, [])

    for (const tool of this.getActiveTools()) {
      const cost = getToolContextCost(tool)
      buckets.get(cost)?.push(tool)
    }

    const lines: string[] = []
    for (const cost of COST_ORDER) {
      const tools = buckets
        .get(cost)!
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
      if (tools.length === 0) continue

      const shown = tools.slice(0, COST_SUMMARY_MAX_TOOLS_PER_BUCKET).map(formatToolForJitSummary)
      const omitted = tools.length - shown.length
      const suffix = omitted > 0 ? `，另 ${omitted} 个` : ''
      lines.push(`${COST_LABELS[cost]}: ${shown.join('；')}${suffix}`)
    }

    return lines.join('\n')
  }

  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r))
    }
    this.concurrentCount++
  }

  private releaseConcurrent(): void {
    this.concurrentCount--
    if (this.concurrentCount === 0) this.drainQueue()
  }

  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r))
    }
    this.exclusiveLock = true
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false
    this.drainQueue()
  }

  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0)
    for (const resolve of waiting) resolve()
  }

  toAISDKFormat(
    context: Partial<ToolExecutionContext> = {},
    options: ToolRegistryFormatOptions = {}
  ): Record<string, any> {
    const result: Record<string, any> = {}
    const activeTools = this.getActiveTools()

    for (const tool of activeTools) {
      const maxChars = tool.maxResultChars
      const executeFn = tool.execute
      const isSafe = tool.isConcurrencySafe === true
      const registry = this

      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any, executionOptions?: unknown) => {
          if (isSafe) {
            await registry.acquireConcurrent()
            if (!registry.quiet) console.log(fmtLockAcquire(tool.name, true))
          } else {
            await registry.acquireExclusive()
            if (!registry.quiet) console.log(fmtLockAcquire(tool.name, false))
          }
          const startedAt = Date.now()
          try {
            const toolCallId = getExecutionToolCallId(executionOptions)
            const cwd = context.cwd ?? registry.cwd
            const agent = context.agent ?? hookAgentFromTeammate(context.teammateIdentity)
            const auditCtx = auditContext({
              cwd,
              ...(context.sessionId ? { sessionId: context.sessionId } : {}),
              agent
            })
            let effectiveInput = input
            getAuditLogger().emit(
              'tool.call',
              createToolCallPayload({
                name: tool.name,
                input,
                ...(toolCallId ? { toolCallId } : {})
              }),
              auditCtx
            )
            if (context.hooks && context.sessionId) {
              const pre = await context.hooks.run(
                createPreToolUseEvent(
                  {
                    sessionId: context.sessionId,
                    cwd,
                    agent
                  },
                  {
                    name: tool.name,
                    input,
                    ...(toolCallId ? { toolCallId } : {})
                  }
                ),
                { signal: context.abortSignal }
              )
              if (pre.blocked) {
                const blocked = {
                  ok: false,
                  error: formatHookBlockedResult(tool.name, pre.reason),
                  code: 'hook_blocked'
                }
                getAuditLogger().emit(
                  'tool.result',
                  createToolResultPayload({
                    name: tool.name,
                    ...(toolCallId ? { toolCallId } : {}),
                    output: blocked.error,
                    ok: false,
                    isError: true,
                    code: blocked.code,
                    durationMs: Date.now() - startedAt
                  }),
                  auditCtx
                )
                return formatToolResult(blocked, maxChars, options)
              }
              if (pre.input !== undefined) {
                effectiveInput = pre.input
              }
            }

            const toolContext: ToolExecutionContext = {
              cwd,
              ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
              ...(context.sessionId ? { sessionId: context.sessionId } : {}),
              ...(context.hooks ? { hooks: context.hooks } : {}),
              ...(context.agent ? { agent: context.agent } : {}),
              ...(context.onProgress
                ? {
                    onProgress: (event) =>
                      context.onProgress?.({
                        ...event,
                        toolName: event.toolName ?? tool.name,
                        ...(toolCallId ? { toolCallId } : {}),
                        input: event.input ?? effectiveInput
                      })
                  }
                : {}),
              ...(context.teammateIdentity ? { teammateIdentity: context.teammateIdentity } : {})
            }
            const raw = await executeFn(effectiveInput, toolContext)
            if (context.hooks && context.sessionId) {
              const post = await context.hooks.run(
                createPostToolUseEvent(
                  {
                    sessionId: context.sessionId,
                    cwd,
                    agent
                  },
                  {
                    name: tool.name,
                    input: effectiveInput,
                    output: raw,
                    ...(toolCallId ? { toolCallId } : {})
                  }
                ),
                { signal: context.abortSignal }
              )
              if (post.blocked) {
                const blocked = {
                  ok: false,
                  error: formatHookBlockedResult(tool.name, post.reason),
                  code: 'hook_blocked'
                }
                getAuditLogger().emit(
                  'tool.result',
                  createToolResultPayload({
                    name: tool.name,
                    ...(toolCallId ? { toolCallId } : {}),
                    output: blocked.error,
                    ok: false,
                    isError: true,
                    code: blocked.code,
                    durationMs: Date.now() - startedAt
                  }),
                  auditCtx
                )
                return formatToolResult(blocked, maxChars, options)
              }
            }
            const envelope = normalizeToolResult(raw)
            getAuditLogger().emit(
              'tool.result',
              createToolResultPayload({
                name: tool.name,
                ...(toolCallId ? { toolCallId } : {}),
                output: envelope.ok ? envelope.content : envelope.error,
                ok: envelope.ok,
                isError: !envelope.ok,
                ...(envelope.code ? { code: envelope.code } : {}),
                durationMs: Date.now() - startedAt
              }),
              auditCtx
            )
            return formatToolResult(raw, maxChars, options)
          } catch (error) {
            const toolCallId = getExecutionToolCallId(executionOptions)
            const cwd = context.cwd ?? registry.cwd
            const durationMs = Date.now() - startedAt
            const failed = {
              ok: false,
              error: formatUnknownError(error),
              code: 'tool_exception'
            }
            getAuditLogger().emit(
              'tool.result',
              createToolResultPayload({
                name: tool.name,
                ...(toolCallId ? { toolCallId } : {}),
                output: failed.error,
                ok: false,
                isError: true,
                code: failed.code,
                durationMs
              }),
              auditContext({
                cwd,
                ...(context.sessionId ? { sessionId: context.sessionId } : {}),
                agent: context.agent ?? hookAgentFromTeammate(context.teammateIdentity)
              })
            )
            return formatToolResult(failed, maxChars, options)
          } finally {
            if (isSafe) {
              registry.releaseConcurrent()
            } else {
              registry.releaseExclusive()
            }
          }
        }
      }
    }
    return result
  }
}

function getToolContextCost(tool: ToolDefinition): ToolContextCost {
  if (tool.contextCost) return tool.contextCost
  return tool.isReadOnly ? 'medium' : 'high'
}

function formatToolForJitSummary(tool: ToolDefinition): string {
  const shape = RESULT_SHAPE_LABELS[tool.resultShape ?? 'unknown']
  const hint = tool.jitHint ? `，${tool.jitHint}` : ''
  return `${tool.name}(${shape}${hint})`
}

/**
 * 将过长工具输出截为 head + tail，中间插入省略提示。
 * @param text - 原始文本
 * @param maxChars - 最大字符数，默认与 registry 一致
 */
export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text

  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  const head = text.slice(0, headSize)
  const tail = text.slice(-tailSize)
  const dropped = text.length - headSize - tailSize

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`
}

/** 构造成功的结构化工具结果信封。 */
export function okToolResult(content: unknown, metadata?: Record<string, unknown>): ToolResultEnvelope {
  return {
    ok: true,
    content,
    ...(metadata ? { metadata } : {})
  }
}

/** 构造失败的结构化工具结果信封。 */
export function errorToolResult(
  error: string,
  options: { code?: string; metadata?: Record<string, unknown> } = {}
): ToolResultEnvelope {
  return {
    ok: false,
    error,
    ...(options.code ? { code: options.code } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {})
  }
}

function isToolVisibleInMode(tool: ToolDefinition, mode: ToolVisibilityMode): boolean {
  if (tool.isEnabled && !tool.isEnabled()) return false

  if (mode === 'plan') {
    // q-code does not have a permission system. Plan mode is enforced by only
    // exposing read-only tools plus explicitly allowed session/planning tools.
    if (tool.name === 'enter_plan_mode') return false
    if (tool.allowInPlanMode === true) return true
    return tool.isReadOnly === true
  }

  return tool.name !== 'plan_write' && tool.name !== 'exit_plan_mode'
}

function getExecutionToolCallId(executionOptions: unknown): string | undefined {
  if (!executionOptions || typeof executionOptions !== 'object') return undefined
  const value = (executionOptions as Record<string, unknown>).toolCallId
  return typeof value === 'string' ? value : undefined
}

function hookAgentFromTeammate(teammate: TeammateIdentity | undefined): HookAgentContext {
  if (!teammate) return { kind: 'main' }
  return {
    kind: 'teammate',
    agentName: teammate.agentName,
    teamName: teammate.teamName
  }
}

function formatHookBlockedResult(toolName: string, reason: string | undefined): string {
  return [
    `[hook blocked] ${toolName} 未执行。`,
    `reason: ${reason || 'Hook blocked this tool call.'}`
  ].join('\n')
}

function formatToolResult(
  raw: ToolExecutionOutput,
  maxChars: number | undefined,
  options: ToolRegistryFormatOptions
): string | ToolResultEnvelope {
  const envelope = normalizeToolResult(raw)
  const text = truncateResult(renderToolResultEnvelope(envelope), maxChars)
  if (options.resultEnvelope !== true) return text
  return {
    ...envelope,
    content: envelope.ok ? text : envelope.content,
    error: envelope.ok ? envelope.error : text
  }
}

function normalizeToolResult(raw: ToolExecutionOutput): ToolResultEnvelope {
  if (isToolResultEnvelope(raw)) return raw
  return {
    ok: true,
    content: raw
  }
}

function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean' &&
    ('content' in value || 'error' in value || 'code' in value || 'metadata' in value)
  )
}

function renderToolResultEnvelope(envelope: ToolResultEnvelope): string {
  if (!envelope.ok) {
    const parts = ['[tool error]', envelope.error || 'Unknown tool error']
    if (envelope.code) parts.push(`code: ${envelope.code}`)
    return parts.join('\n')
  }
  const content = envelope.content
  if (typeof content === 'string') return content
  return JSON.stringify(content ?? null, null, 2)
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
