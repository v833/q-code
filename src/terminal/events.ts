/**
 * TUI 与 CLI 主循环之间的事件契约：角色/状态类型、 discriminated union 事件，
 * 以及内存实现的 {@link TerminalEventBus}。
 */
import type { TokenUsage } from '../context/token-budget'
import type { SessionSummary } from '../session/store'
import type { SlashCommandSuggestion } from '../slash'
import type { CacheMode } from '../usage'

/** transcript 消息角色。 */
export type TerminalRole = 'assistant' | 'user' | 'system' | 'tool' | 'error'
/** 状态栏展示的 Agent/工具执行阶段。 */
export type TerminalStatus = 'idle' | 'thinking' | 'running_tool' | 'compacting' | 'recovering' | 'error'

/** TodoWrite 等进度条目的完成状态。 */
export type TerminalProgressStatus = 'pending' | 'in_progress' | 'completed'

/** 状态栏中的一条进度项（来自 TodoWrite 或类似来源）。 */
export interface TerminalProgressItem {
  content: string
  status: TerminalProgressStatus
  activeForm?: string
}

/** 后台 SubAgent 在状态栏中的摘要行。 */
export interface TerminalBackgroundAgentItem {
  agentId: string
  agentType: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  isolated?: boolean
  worktreePath?: string
  worktreeBranch?: string
  lastToolName?: string
  toolUseCount?: number
  totalTokens?: number
  durationMs?: number
  outputFile?: string
  error?: string
}

/** 多数终端事件共用的可选溯源字段。 */
export interface TerminalBaseEvent {
  source?: string
  agentId?: string
  sessionId?: string
}

/** CLI → TUI 的全部事件变体；由 {@link terminalReducer} 消费。 */
export type TerminalEvent =
  | (TerminalBaseEvent & {
      type: 'message'
      role: TerminalRole
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'assistant_delta'
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'assistant_done'
    })
  | (TerminalBaseEvent & {
      type: 'tool_call'
      name: string
      input?: unknown
      toolCallId?: string
      contextCost?: string
      resultShape?: string
    })
  | (TerminalBaseEvent & {
      type: 'tool_result'
      name: string
      output?: unknown
      toolCallId?: string
      resultLength?: number
      isError?: boolean
    })
  | (TerminalBaseEvent & {
      type: 'status'
      status: TerminalStatus
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'context_usage'
      used: number
      limit: number
      state?: string
      detail?: string
    })
  | (TerminalBaseEvent & {
      type: 'context_offload'
      offloaded: number
      chars: number
      files?: string[]
    })
  | (TerminalBaseEvent & {
      type: 'jit_context'
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'usage'
      turnUsage: TokenUsage
      totalUsage: TokenUsage
    })
  | (TerminalBaseEvent & {
      type: 'session_info'
      sessionId: string
      cwd?: string
      modelName: string
      agentMode: string
      taskMode: string
      cacheMode: CacheMode
    })
  | (TerminalBaseEvent & {
      type: 'status_details_visibility'
      visible: boolean
    })
  | (TerminalBaseEvent & {
      type: 'plan_entry_suggestion'
      request: string
      reason: string
    })
  | (TerminalBaseEvent & {
      type: 'plan_entry_suggestion_clear'
    })
  | (TerminalBaseEvent & {
      type: 'progress'
      items: TerminalProgressItem[]
    })
  | (TerminalBaseEvent & {
      type: 'background_agents'
      agents: TerminalBackgroundAgentItem[]
    })
  | (TerminalBaseEvent & {
      type: 'error'
      text: string
    })
  | (TerminalBaseEvent & {
      type: 'clear'
    })
  | (TerminalBaseEvent & {
      type: 'slash_commands'
      commands: SlashCommandSuggestion[]
    })
  | (TerminalBaseEvent & {
      type: 'session_picker'
      sessions: SessionSummary[]
      selectedIndex: number
      currentSessionId: string
    })
  | (TerminalBaseEvent & {
      type: 'session_picker_close'
    })
  | (TerminalBaseEvent & {
      type: 'models_picker'
      models: Array<{ id: string; displayName: string }>
      selectedIndex: number
      activeModelName: string
      endpointLabel: string
    })
  | (TerminalBaseEvent & {
      type: 'models_picker_close'
    })

export type TerminalEventListener = (event: TerminalEvent) => void

/** 终端事件发布/订阅抽象；TUI 与主循环解耦。 */
export interface TerminalEventBus {
  emit(event: TerminalEvent): void
  subscribe(listener: TerminalEventListener): () => void
}

/**
 * 进程内事件总线：保留有限历史，新订阅者会重放历史以便恢复 UI。
 */
export class InMemoryTerminalEventBus implements TerminalEventBus {
  private listeners = new Set<TerminalEventListener>()
  private history: TerminalEvent[] = []
  private readonly maxHistory: number

  constructor(options: { maxHistory?: number } = {}) {
    this.maxHistory = options.maxHistory ?? 500
  }

  emit(event: TerminalEvent): void {
    this.history.push(event)
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory)
    }
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: TerminalEventListener): () => void {
    this.listeners.add(listener)
    for (const event of this.history) listener(event)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
