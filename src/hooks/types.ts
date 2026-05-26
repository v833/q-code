/**
 * Hooks 类型定义：事件载荷、匹配器、处理器决策与 Runner 接口。
 */

/** 支持的 Hook 事件名。 */
export type HookEventName =
  | 'session_start'
  | 'session_end'
  | 'user_prompt_submit'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop'
  | 'subagent_start'
  | 'subagent_stop'

/** Hook 定义来源作用域。 */
export type HookScope = 'user' | 'project' | 'runtime'

/** 触发 Hook 的 Agent 种类。 */
export type HookAgentKind = 'main' | 'subagent' | 'teammate'

/** 写入 Hook 事件的 Agent 身份上下文。 */
export interface HookAgentContext {
  kind: HookAgentKind
  agentType?: string
  agentId?: string
  agentName?: string
  teamName?: string
}

/** 所有 Hook 事件共享的基础字段。 */
export interface HookBaseEvent {
  event: HookEventName
  sessionId: string
  cwd: string
  timestamp: string
  agent: HookAgentContext
}

/** 会话开始事件。 */
export interface HookSessionStartEvent extends HookBaseEvent {
  event: 'session_start'
}

/** 会话结束事件。 */
export interface HookSessionEndEvent extends HookBaseEvent {
  event: 'session_end'
  reason?: string
}

/** 用户提交 prompt 事件。 */
export interface HookUserPromptSubmitEvent extends HookBaseEvent {
  event: 'user_prompt_submit'
  prompt: string
}

/** 工具调用前事件，可 block/modify input。 */
export interface HookPreToolUseEvent extends HookBaseEvent {
  event: 'pre_tool_use'
  tool: {
    name: string
    input: unknown
    toolCallId?: string
  }
}

/** 工具调用后事件，可 modify output。 */
export interface HookPostToolUseEvent extends HookBaseEvent {
  event: 'post_tool_use'
  tool: {
    name: string
    input: unknown
    output: unknown
    toolCallId?: string
    isError?: boolean
  }
}

/** Agent 主循环停止事件。 */
export interface HookStopEvent extends HookBaseEvent {
  event: 'stop'
  reason?: string
}

/** 子 Agent 启动事件。 */
export interface HookSubagentStartEvent extends HookBaseEvent {
  event: 'subagent_start'
  subagent: {
    agentType: string
    prompt: string
    description?: string
  }
}

/** 子 Agent 结束事件。 */
export interface HookSubagentStopEvent extends HookBaseEvent {
  event: 'subagent_stop'
  subagent: {
    agentType: string
    finalText?: string
    reason?: string
  }
}

/** 所有 Hook 事件类型的联合。 */
export type HookEvent =
  | HookSessionStartEvent
  | HookSessionEndEvent
  | HookUserPromptSubmitEvent
  | HookPreToolUseEvent
  | HookPostToolUseEvent
  | HookStopEvent
  | HookSubagentStartEvent
  | HookSubagentStopEvent

/** Hook 匹配条件：可按事件、工具名、Agent 类型过滤。 */
export interface HookMatcher {
  tool?: string | string[]
  event?: HookEventName | HookEventName[]
  agentKind?: HookAgentKind | HookAgentKind[]
  agentType?: string | string[]
}

/** Hook 处理器返回的决策（continue / warn / block / modify）。 */
export type HookDecision =
  | { action: 'continue' }
  | { action: 'warn'; message: string }
  | { action: 'block'; reason: string }
  | { action: 'modify'; input?: unknown; output?: unknown; message?: string }

/** Hook 处理器返回值，可附带 metadata。 */
export type HookHandlerResult = HookDecision & {
  metadata?: Record<string, unknown>
}

/** 传入 in-process Hook 处理器的运行时上下文。 */
export interface HookHandlerContext {
  signal?: AbortSignal
}

/** 进程内 Hook 处理器函数签名。 */
export type HookHandler = (
  event: HookEvent,
  context: HookHandlerContext
) => Promise<HookHandlerResult | void> | HookHandlerResult | void

/** 通过外部命令实现的 Hook 定义。 */
export interface HookCommandDefinition {
  name: string
  type: 'command'
  event: HookEventName
  matcher?: HookMatcher
  command: string
  timeoutMs?: number
  blocking?: boolean
  scope: HookScope
  sourcePath?: string
}

/** 通过进程内函数实现的 Hook 定义。 */
export interface HookInProcessDefinition {
  name: string
  type: 'handler'
  event: HookEventName
  matcher?: HookMatcher
  handler: HookHandler
  timeoutMs?: number
  blocking?: boolean
  scope: HookScope
  sourcePath?: string
}

/** Hook 定义联合类型。 */
export type HookDefinition = HookCommandDefinition | HookInProcessDefinition

/** 单次 Hook 执行的审计记录。 */
export interface HookExecutionRecord {
  hookName: string
  event: HookEventName
  scope: HookScope
  matched: boolean
  durationMs?: number
  action?: HookDecision['action']
  error?: string
  message?: string
}

/** `HookRunner.run` 的聚合结果。 */
export interface HookRunResult {
  blocked: boolean
  reason?: string
  input?: unknown
  output?: unknown
  warnings: string[]
  records: HookExecutionRecord[]
}

/** Hook 运行器接口，由 ToolRegistry 与主循环调用。 */
export interface HookRunner {
  run(event: HookEvent, options?: { signal?: AbortSignal }): Promise<HookRunResult>
  list(): HookDefinition[]
  describe(): string
}
