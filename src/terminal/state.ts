/**
 * TUI 可渲染状态：`TerminalState`、transcript 条目类型，以及将 {@link TerminalEvent} 归约为状态的 reducer。
 */
import type {
  TerminalBackgroundAgentItem,
  TerminalEvent,
  TerminalProgressItem,
  TerminalRole,
  TerminalStatus
} from './events'
import type { SessionSummary } from '../session/store'
import type { SlashCommandSuggestion } from '../slash'
import type { CacheMode } from '../usage'

/** transcript 中单条记录的类别。 */
export type TranscriptItemKind = 'message' | 'tool' | 'usage' | 'context'

/** 对话区一条可渲染记录（消息、工具调用、用量或上下文事件）。 */
export interface TranscriptItem {
  id: string
  kind: TranscriptItemKind
  role?: TerminalRole
  title?: string
  text: string
  status?: 'running' | 'done' | 'error'
  isStreaming?: boolean
  source?: string
  agentId?: string
  meta?: TranscriptItemMeta
}

/** 工具类 transcript 条目的附加元数据（预览、恢复提示等）。 */
export interface TranscriptItemMeta {
  toolName?: string
  intermediateAssistant?: boolean
  resultLength?: number
  resultShape?: string
  contextCost?: string
  durationMs?: number
  recoveryHint?: string
  offloadFiles?: string[]
}

/** 上下文 token 占用快照，供状态栏 ContextMeter 使用。 */
export interface TerminalContextUsage {
  used: number
  limit: number
  state?: string
}

/** 累计 token 用量摘要。 */
export interface TerminalUsage {
  totalTokens: number
  inputTokens: number
  outputTokens: number
}

/** 顶栏/状态栏展示的会话与模式信息。 */
export interface TerminalSessionInfo {
  sessionId: string
  cwd?: string
  modelName: string
  agentMode: string
  taskMode: string
  cacheMode: CacheMode
}

/** TUI 全局 UI 状态，由 {@link terminalReducer} 根据事件更新。 */
export interface TerminalState {
  transcript: TranscriptItem[]
  status: TerminalStatus
  statusText: string
  contextUsage?: TerminalContextUsage
  usage?: TerminalUsage
  sessionInfo?: TerminalSessionInfo
  statusDetailsVisible: boolean
  slashCommands: SlashCommandSuggestion[]
  sessionPicker?: {
    sessions: SessionSummary[]
    selectedIndex: number
    currentSessionId: string
  }
  progressItems: TerminalProgressItem[]
  backgroundAgents: TerminalBackgroundAgentItem[]
  jitMessages: string[]
  activeAssistantId?: string
  activeToolIds: Record<string, string>
  nextId: number
}

const MAX_TRANSCRIPT_ITEMS = 400
const NOISY_SUCCESS_TOOL_RESULTS = new Set(['read_file', 'grep'])

/** 创建空的 {@link TerminalState}（Ready、空 transcript）。 */
export function createInitialTerminalState(): TerminalState {
  return {
    transcript: [],
    status: 'idle',
    statusText: 'Ready',
    statusDetailsVisible: false,
    slashCommands: [],
    sessionPicker: undefined,
    progressItems: [],
    backgroundAgents: [],
    jitMessages: [],
    activeToolIds: {},
    nextId: 1
  }
}

/**
 * 将 {@link TerminalEvent} 应用到 {@link TerminalState}：维护流式 assistant、
 * 工具调用配对、上下文/用量条与 transcript 上限。
 */
export function terminalReducer(state: TerminalState, event: TerminalEvent): TerminalState {
  switch (event.type) {
    case 'message': {
      if (event.role === 'assistant' && isDuplicateFinalAssistantMessage(state, event.text)) {
        return state
      }
      if (event.role === 'assistant' && state.activeAssistantId) {
        return {
          ...state,
          status: state.status === 'thinking' ? 'idle' : state.status,
          statusText: state.status === 'thinking' ? 'Ready' : state.statusText,
          activeAssistantId: undefined,
          transcript: state.transcript.map((item) =>
            item.id === state.activeAssistantId
              ? {
                  ...item,
                  text: event.text,
                  isStreaming: false,
                  source: event.source,
                  agentId: event.agentId
                }
              : item
          )
        }
      }
      return appendItem(
        state,
        {
          kind: 'message',
          role: event.role,
          text: event.text,
          isStreaming: event.role === 'assistant' ? false : undefined,
          source: event.source,
          agentId: event.agentId
        }
      )
    }

    case 'assistant_delta': {
      if (state.activeAssistantId) {
        return {
          ...state,
          status: 'thinking',
          statusText: 'Assistant streaming',
          transcript: state.transcript.map((item) =>
            item.id === state.activeAssistantId ? { ...item, text: item.text + event.text } : item
          )
        }
      }

      const next = appendItem({
        ...state,
        status: 'thinking',
        statusText: 'Assistant streaming'
      }, {
        kind: 'message',
        role: 'assistant',
        text: event.text,
        isStreaming: true
      })
      const item = next.transcript[next.transcript.length - 1]
      return item ? { ...next, activeAssistantId: item.id } : next
    }

    case 'assistant_done': {
      if (!state.activeAssistantId) {
        return {
          ...state,
          status: state.status === 'thinking' ? 'idle' : state.status,
          statusText: state.status === 'thinking' ? 'Ready' : state.statusText
        }
      }

      return {
        ...state,
        status: state.status === 'thinking' ? 'idle' : state.status,
        statusText: state.status === 'thinking' ? 'Ready' : state.statusText,
        activeAssistantId: undefined,
        transcript: state.transcript.map((item) =>
          item.id === state.activeAssistantId ? { ...item, isStreaming: false } : item
        )
      }
    }

    case 'tool_call': {
      const title = event.name
      const text = formatToolInput(event.input)
      const stateWithClosedAssistant = closeActiveAssistantStream(state)
      const next = appendItem(
        { ...stateWithClosedAssistant, status: 'running_tool', statusText: `Running ${event.name}` },
        {
          kind: 'tool',
          role: 'tool',
          title,
          text,
          status: 'running',
          source: event.source,
          agentId: event.agentId,
          meta: {
            toolName: event.name,
            contextCost: event.contextCost,
            resultShape: event.resultShape
          }
        }
      )
      const item = next.transcript[next.transcript.length - 1]
      if (!event.toolCallId || !item) return next
      return {
        ...next,
        activeToolIds: {
          ...next.activeToolIds,
          [event.toolCallId]: item.id
        }
      }
    }

    case 'tool_result': {
      const toolItemId = event.toolCallId ? state.activeToolIds[event.toolCallId] : undefined
      const resultText = formatToolResult(
        event.name,
        event.output,
        event.resultLength,
        event.isError
      )
      const status = event.isError ? 'error' : 'done'
      const recoveryHint = event.isError ? formatRecoveryHint(event.name) : undefined
      const nextActiveToolIds = { ...state.activeToolIds }
      if (event.toolCallId) delete nextActiveToolIds[event.toolCallId]

      if (toolItemId) {
        return {
          ...state,
          status: event.isError
            ? 'recovering'
            : Object.keys(nextActiveToolIds).length > 0
              ? 'running_tool'
              : 'thinking',
          statusText:
            event.isError
              ? `Recovering from ${event.name}`
              : Object.keys(nextActiveToolIds).length > 0
                ? state.statusText
                : 'Thinking',
          activeToolIds: nextActiveToolIds,
          transcript: state.transcript.map((item) =>
            item.id === toolItemId
              ? {
                  ...item,
                  status,
                  text: item.text ? `${item.text}\n${resultText}` : resultText,
                  meta: {
                    ...item.meta,
                    toolName: event.name,
                    resultLength: event.resultLength,
                    ...(recoveryHint ? { recoveryHint } : {})
                  }
                }
              : item
          )
        }
      }

      return appendItem(
        {
          ...state,
          status: Object.keys(nextActiveToolIds).length > 0 ? 'running_tool' : 'thinking',
          statusText:
            Object.keys(nextActiveToolIds).length > 0 ? state.statusText : 'Thinking',
          activeToolIds: nextActiveToolIds
        },
        {
          kind: 'tool',
          role: 'tool',
          title: event.name,
          text: resultText,
          status,
          source: event.source,
          agentId: event.agentId,
          meta: {
            toolName: event.name,
            resultLength: event.resultLength,
            ...(recoveryHint ? { recoveryHint } : {})
          }
        }
      )
    }

    case 'status':
      return {
        ...state,
        status: event.status,
        statusText: event.text
      }

    case 'context_usage': {
      const nextState = {
        ...state,
        contextUsage: {
          used: event.used,
          limit: event.limit,
          state: event.state
        },
        jitMessages: event.detail ? pushRecent(state.jitMessages, event.detail, 4) : state.jitMessages
      }
      const shouldLogContext =
        event.state !== undefined &&
        event.state !== 'normal' &&
        state.contextUsage?.state !== event.state
      if (!shouldLogContext) return nextState
      return appendItem(nextState, {
        kind: 'context',
        text: `上下文 ${event.used}/${event.limit} tokens (${Math.round((event.used / event.limit) * 100)}%) ${event.state}`
      })
    }

    case 'context_offload': {
      const text = `上下文卸载: ${event.offloaded} 个大工具结果，释放 ${event.chars} chars`
      return appendItem(
        {
          ...state,
          status: 'compacting',
          statusText: 'Context offloading',
          jitMessages: pushRecent(state.jitMessages, text, 4)
        },
        {
          kind: 'context',
          text,
          meta: {
            resultLength: event.chars,
            offloadFiles: event.files
          }
        }
      )
    }

    case 'jit_context':
      return {
        ...state,
        jitMessages: pushRecent(state.jitMessages, event.text, 4)
      }

    case 'usage':
      return {
        ...state,
        usage: {
          totalTokens: event.totalUsage.totalTokens,
          inputTokens: event.totalUsage.inputTokens,
          outputTokens: event.totalUsage.outputTokens
        }
      }

    case 'session_info':
      return {
        ...state,
        sessionInfo: {
          sessionId: event.sessionId,
          ...(event.cwd ? { cwd: event.cwd } : {}),
          modelName: event.modelName,
          agentMode: event.agentMode,
          taskMode: event.taskMode,
          cacheMode: event.cacheMode
        }
      }

    case 'status_details_visibility':
      return {
        ...state,
        statusDetailsVisible: event.visible
      }

    case 'error':
      return appendItem(
        {
          ...state,
          status: 'error',
          statusText: event.text
        },
        {
          kind: 'message',
          role: 'error',
          text: event.text,
          source: event.source,
          agentId: event.agentId
        }
      )

    case 'clear':
      return {
        ...state,
        transcript: [],
        activeAssistantId: undefined,
        activeToolIds: {},
        progressItems: [],
        backgroundAgents: [],
        status: 'idle',
        statusText: 'Ready'
      }

    case 'slash_commands':
      return {
        ...state,
        slashCommands: event.commands
      }

    case 'session_picker':
      return {
        ...state,
        sessionPicker: {
          sessions: event.sessions,
          selectedIndex: event.selectedIndex,
          currentSessionId: event.currentSessionId
        }
      }

    case 'session_picker_close':
      return {
        ...state,
        sessionPicker: undefined
      }

    case 'progress':
      return {
        ...state,
        progressItems: event.items
      }

    case 'background_agents':
      return {
        ...state,
        backgroundAgents: event.agents
      }
  }
}

function pushRecent(items: readonly string[], item: string, max: number): string[] {
  return [...items.filter((entry) => entry !== item), item].slice(-max)
}

function appendItem(
  state: TerminalState,
  item: Omit<TranscriptItem, 'id'>
): TerminalState {
  const nextItem: TranscriptItem = {
    ...item,
    id: `t-${state.nextId}`
  }
  const transcript = [...state.transcript, nextItem].slice(-MAX_TRANSCRIPT_ITEMS)
  return {
    ...state,
    nextId: state.nextId + 1,
    transcript
  }
}

function closeActiveAssistantStream(state: TerminalState): TerminalState {
  if (!state.activeAssistantId) return state
  return {
    ...state,
    activeAssistantId: undefined,
    transcript: state.transcript.map((item) =>
      item.id === state.activeAssistantId
        ? {
            ...item,
            isStreaming: false,
            meta: {
              ...item.meta,
              intermediateAssistant: true
            }
          }
        : item
    )
  }
}

function isDuplicateFinalAssistantMessage(state: TerminalState, text: string): boolean {
  const last = state.transcript[state.transcript.length - 1]
  return last?.role === 'assistant' && last.isStreaming !== true && last.text === text
}

function formatToolInput(input: unknown): string {
  if (input === undefined) return 'Input: {}'
  return `Input: ${truncateSingleLine(stringifyCompact(input), 900)}`
}

function formatToolResult(
  name: string,
  output: unknown,
  resultLength: number | undefined,
  isError: boolean | undefined
): string {
  const prefix = isError ? 'Error' : 'Result'
  if (!isError && NOISY_SUCCESS_TOOL_RESULTS.has(name)) {
    const length = resultLength === undefined ? '' : ` (${resultLength} chars)`
    return `${prefix}: terminal output hidden${length}`
  }
  if (output === undefined) {
    return resultLength === undefined ? prefix : `${prefix}: ${resultLength} chars`
  }
  return formatTwoLinePreview(prefix, stringifyUnknown(output), resultLength)
}

function formatRecoveryHint(name: string): string {
  return `建议：检查 ${name} 的输入、权限或路径；必要时换一个更小的查询重试。`
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatTwoLinePreview(
  prefix: string,
  text: string,
  resultLength: number | undefined
): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const firstLine = lines[0] ?? ''
  const display = `${prefix}: ${truncateSingleLine(firstLine, 220)}`
  const length = resultLength ?? normalized.length
  const isTruncated = lines.length > 1 || firstLine.length > 220 || length > firstLine.length
  if (!isTruncated) return display
  const moreLines = lines.length > 1 ? `, ${lines.length - 1} more lines` : ''
  return `${display}\n... truncated ${length} chars${moreLines}`
}

function truncateSingleLine(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= maxChars) return singleLine
  return `${singleLine.slice(0, maxChars - 16)}... truncated`
}
