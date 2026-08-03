import { describe, expect, it } from 'vitest'
import {
  mapConversationEventToCodex,
  serializeCodexEvent,
} from '../../src/cli/codex-jsonl'

describe('Codex JSONL event mapping', () => {
  it('maps the session and turn lifecycle', () => {
    expect(mapConversationEventToCodex({
      type: 'session_started',
      sessionId: 'session-1',
    })).toEqual({ type: 'thread.started', thread_id: 'session-1' })
    expect(mapConversationEventToCodex({ type: 'turn_started' }))
      .toEqual({ type: 'turn.started' })
    expect(mapConversationEventToCodex({
      type: 'assistant_completed',
      messageId: 'message-1',
      text: '完成',
    })).toEqual({
      type: 'item.completed',
      item: { id: 'message-1', type: 'agent_message', text: '完成' },
    })
    expect(mapConversationEventToCodex({
      type: 'turn_completed',
      usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 },
    })).toEqual({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 },
    })
  })

  it('maps shell tools to command_execution items', () => {
    expect(mapConversationEventToCodex({
      type: 'tool_started',
      toolCallId: 'tool-1',
      name: 'f',
      input: { command: 'Get-ChildItem' },
    })).toEqual({
      type: 'item.started',
      item: {
        id: 'tool-1',
        type: 'command_execution',
        command: 'Get-ChildItem',
        status: 'in_progress',
      },
    })

    expect(mapConversationEventToCodex({
      type: 'tool_completed',
      toolCallId: 'tool-1',
      name: 'f',
      input: { command: 'Get-ChildItem' },
      output: 'package.json',
      isError: false,
    })).toEqual({
      type: 'item.completed',
      item: {
        id: 'tool-1',
        type: 'command_execution',
        command: 'Get-ChildItem',
        aggregated_output: 'package.json',
        exit_code: 0,
        status: 'completed',
      },
    })
  })

  it('maps file writes and other tools', () => {
    expect(mapConversationEventToCodex({
      type: 'tool_started',
      toolCallId: 'tool-file',
      name: 'write_file',
      input: { path: 'README.md', content: 'x' },
    })).toMatchObject({
      type: 'item.started',
      item: {
        id: 'tool-file',
        type: 'file_change',
        changes: [{ path: 'README.md', kind: 'update' }],
      },
    })

    expect(mapConversationEventToCodex({
      type: 'tool_completed',
      toolCallId: 'tool-other',
      name: 'grep',
      input: { pattern: 'TODO' },
      output: ['a.ts:1'],
      isError: true,
    })).toMatchObject({
      type: 'item.completed',
      item: {
        id: 'tool-other',
        type: 'mcp_tool_call',
        server: 'q-code',
        tool: 'grep',
        status: 'failed',
      },
    })

    expect(mapConversationEventToCodex({
      type: 'tool_started',
      toolCallId: 'tool-mcp',
      name: 'mcp__github__search_issues',
      input: { query: 'bug' },
    })).toMatchObject({
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        server: 'github',
        tool: 'search_issues',
      },
    })
  })

  it('maps failures and serializes exactly one JSON line', () => {
    expect(mapConversationEventToCodex({
      type: 'turn_failed',
      message: '请求失败',
    })).toEqual({ type: 'turn.failed', error: { message: '请求失败' } })
    expect(mapConversationEventToCodex({
      type: 'runtime_error',
      message: '配置失败',
    })).toEqual({ type: 'error', message: '配置失败' })

    const line = serializeCodexEvent({ type: 'turn.started' })
    expect(line).toBe('{"type":"turn.started"}\n')
    expect(line).not.toMatch(/\x1b/)
  })
})
