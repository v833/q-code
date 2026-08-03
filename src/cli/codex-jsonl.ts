/**
 * ConversationRuntime 中立事件到 Codex CLI JSONL 的协议适配。
 */
import type { ConversationEvent } from './conversation-events'
import { parseMcpToolName } from '../mcp/names'

/** 可序列化的 Codex JSONL 事件。 */
export type CodexJsonEvent = Record<string, unknown>

const SHELL_TOOL_NAMES = new Set(['f', 'f_status', 'f_tail', 'f_kill', 'f_list'])
const FILE_TOOL_NAMES = new Set(['write_file', 'edit_file'])

/** 把一条 Runtime 事件映射为 Codex JSONL 事件。 */
export function mapConversationEventToCodex(event: ConversationEvent): CodexJsonEvent {
  switch (event.type) {
    case 'session_started':
      return { type: 'thread.started', thread_id: event.sessionId }
    case 'turn_started':
      return { type: 'turn.started' }
    case 'tool_started':
      return {
        type: 'item.started',
        item: createToolItem(event.name, event.toolCallId, event.input, undefined, false, 'in_progress'),
      }
    case 'tool_completed':
      return {
        type: 'item.completed',
        item: createToolItem(
          event.name,
          event.toolCallId,
          event.input,
          event.output,
          event.isError,
          event.isError ? 'failed' : 'completed',
        ),
      }
    case 'assistant_completed':
      return {
        type: 'item.completed',
        item: { id: event.messageId, type: 'agent_message', text: event.text },
      }
    case 'turn_completed':
      return {
        type: 'turn.completed',
        usage: {
          input_tokens: event.usage.inputTokens,
          cached_input_tokens: event.usage.cachedInputTokens ?? 0,
          output_tokens: event.usage.outputTokens,
        },
      }
    case 'turn_failed':
      return { type: 'turn.failed', error: { message: event.message } }
    case 'runtime_error':
      return { type: 'error', message: event.message }
  }
}

/** 把一条 Codex 事件编码为恰好一行 UTF-8 JSONL 文本。 */
export function serializeCodexEvent(event: CodexJsonEvent): string {
  return `${JSON.stringify(event)}\n`
}

function createToolItem(
  name: string,
  toolCallId: string,
  input: unknown,
  output: unknown,
  isError: boolean,
  status: 'in_progress' | 'completed' | 'failed',
): Record<string, unknown> {
  if (SHELL_TOOL_NAMES.has(name)) {
    const command = readStringField(input, 'command') ?? formatFallbackCommand(name, input)
    return {
      id: toolCallId,
      type: 'command_execution',
      command,
      ...(status === 'in_progress'
        ? {}
        : {
            aggregated_output: formatOutput(output),
            exit_code: isError ? 1 : 0,
          }),
      status,
    }
  }

  if (FILE_TOOL_NAMES.has(name)) {
    const path = readStringField(input, 'path') ?? readStringField(input, 'filePath') ?? '(unknown)'
    return {
      id: toolCallId,
      type: 'file_change',
      changes: [{ path, kind: 'update' }],
      status,
    }
  }

  const mcpTool = parseMcpToolName(name)
  return {
    id: toolCallId,
    type: 'mcp_tool_call',
    server: mcpTool?.serverName ?? 'q-code',
    tool: mcpTool?.toolName ?? name,
    arguments: input ?? {},
    ...(status === 'in_progress'
      ? {}
      : isError
        ? { error: formatOutput(output) }
        : { result: output }),
    status,
  }
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = (value as Record<string, unknown>)[field]
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined
}

function formatFallbackCommand(name: string, input: unknown): string {
  if (input === undefined) return name
  try {
    return `${name} ${JSON.stringify(input)}`
  } catch {
    return `${name} ${String(input)}`
  }
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}
