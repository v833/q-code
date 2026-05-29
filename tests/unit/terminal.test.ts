import { describe, expect, it } from 'vitest'
import {
  createInitialTerminalState,
  terminalReducer
} from '../../src/terminal/state'
import {
  backspace,
  clearOrRestoreInput,
  createInputState,
  deleteForward,
  getInputCursorPosition,
  insertText,
  moveCursor,
  normalizePastedText,
  recallNext,
  recallPrevious,
  renderInputValue,
  renderPromptInputRows,
  renderInputWithCursor,
  searchHistoryPrevious,
  submitInput
} from '../../src/terminal/input'
import { shouldBackspace, shouldDeleteForward } from '../../src/terminal/keys'
import { parseMarkdown } from '../../src/terminal/markdown'
import {
  MARKDOWN_PARSE_CHAR_LIMIT,
  previewStreamingText,
  shouldParseMarkdownText
} from '../../src/terminal/components/MarkdownText'
import { getCursorRowsFromFrameEnd } from '../../src/terminal/components/InputPrompt'
import { renderMarkdownTable } from '../../src/terminal/table-renderer'
import {
  estimateItemRows,
  estimateWrappedRows,
  hideCompletedTurnTools,
  splitStaticAndLiveTranscript,
  takeUnprintedStaticItems
} from '../../src/terminal/utils/layout'
import { formatStaticTranscriptItems } from '../../src/terminal/utils/static-output'
import { stringDisplayWidth } from '../../src/terminal/utils/string-width'
import { formatStartupDuckBanner, STARTUP_DUCK_SOURCE } from '../../src/terminal/utils/duck'
import type { SlashCommandSuggestion } from '../../src/slash'

describe('terminal state reducer', () => {
  it('streams assistant deltas into one transcript item', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: 'hello' })
    state = terminalReducer(state, { type: 'assistant_delta', text: ' world' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.role).toBe('assistant')
    expect(state.transcript[0]?.text).toBe('hello world')
    expect(state.transcript[0]?.isStreaming).toBe(true)
    expect(state.activeAssistantId).toBe(state.transcript[0]?.id)

    state = terminalReducer(state, { type: 'assistant_done' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.role).toBe('assistant')
    expect(state.transcript[0]?.text).toBe('hello world')
    expect(state.transcript[0]?.isStreaming).toBe(false)
    expect(state.activeAssistantId).toBeUndefined()
  })

  it('closes the current assistant stream when a tool call starts', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: '我先看入口文件。' })
    state = terminalReducer(state, {
      type: 'tool_call',
      name: 'read_file',
      toolCallId: 'call-1',
      input: { path: 'src/index.ts' }
    })
    state = terminalReducer(state, {
      type: 'tool_result',
      name: 'read_file',
      toolCallId: 'call-1',
      output: 'ok',
      resultLength: 2
    })
    state = terminalReducer(state, { type: 'assistant_delta', text: '入口确认了，我继续看渲染链路。' })

    expect(state.transcript).toHaveLength(3)
    expect(state.transcript[0]).toMatchObject({
      role: 'assistant',
      text: '我先看入口文件。',
      isStreaming: false,
      meta: {
        intermediateAssistant: true
      }
    })
    expect(state.transcript[1]).toMatchObject({
      kind: 'tool',
      title: 'read_file',
      status: 'done'
    })
    expect(state.transcript[2]).toMatchObject({
      role: 'assistant',
      text: '入口确认了，我继续看渲染链路。',
      isStreaming: true
    })
    expect(state.activeAssistantId).toBe(state.transcript[2]?.id)
  })

  it('replaces an active assistant stream with a final assistant message', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: 'partial' })
    state = terminalReducer(state, { type: 'message', role: 'assistant', text: 'final answer' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.role).toBe('assistant')
    expect(state.transcript[0]?.text).toBe('final answer')
    expect(state.transcript[0]?.isStreaming).toBe(false)
    expect(state.activeAssistantId).toBeUndefined()
  })

  it('does not duplicate assistant text when done is emitted after a final assistant message', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: 'partial' })
    state = terminalReducer(state, { type: 'message', role: 'assistant', text: 'final answer' })
    state = terminalReducer(state, { type: 'assistant_done' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.text).toBe('final answer')
    expect(state.transcript[0]?.isStreaming).toBe(false)
    expect(state.activeAssistantId).toBeUndefined()
  })

  it('does not duplicate an assistant final message after streaming is completed', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'assistant_delta', text: 'final answer' })
    state = terminalReducer(state, { type: 'assistant_done' })
    state = terminalReducer(state, { type: 'message', role: 'assistant', text: 'final answer' })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.text).toBe('final answer')
    expect(state.transcript[0]?.isStreaming).toBe(false)
  })

  it('links tool call and result by toolCallId', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'tool_call',
      name: 'read_file',
      toolCallId: 'call-1',
      input: { path: 'README.md' }
    })
    state = terminalReducer(state, {
      type: 'tool_result',
      name: 'read_file',
      toolCallId: 'call-1',
      output: 'ok'
    })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.title).toBe('read_file')
    expect(state.transcript[0]?.status).toBe('done')
    expect(state.transcript[0]?.text).toContain('Input: {"path":"README.md"}')
    expect(state.transcript[0]?.text).toContain('Result: terminal output hidden')
    expect(state.activeToolIds).toEqual({})
  })

  it('limits tool result previews to at most two lines', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'tool_call',
      name: 'shell',
      toolCallId: 'call-1',
      input: { command: 'long-output' }
    })
    state = terminalReducer(state, {
      type: 'tool_result',
      name: 'shell',
      toolCallId: 'call-1',
      output: ['line 1', 'line 2', 'line 3'].join('\n'),
      resultLength: 20
    })

    const text = state.transcript[0]?.text ?? ''
    const resultLines = text.split('\n').filter((line) => line.startsWith('Result:') || line.startsWith('... truncated'))
    expect(text).toContain('Input: {"command":"long-output"}')
    expect(resultLines).toHaveLength(2)
  })

  it('keeps thinking status after a tool result while the turn continues', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'tool_call',
      name: 'task_list',
      toolCallId: 'call-1',
      input: {}
    })
    state = terminalReducer(state, {
      type: 'tool_result',
      name: 'task_list',
      toolCallId: 'call-1',
      output: 'Tasks: 当前没有任务。'
    })

    expect(state.status).toBe('thinking')
    expect(state.statusText).toBe('Thinking')
    expect(state.activeToolIds).toEqual({})
  })

  it('renders failed tool results once with the error output', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'tool_call',
      name: 'bash',
      toolCallId: 'call-1',
      input: { command: 'bad' }
    })
    state = terminalReducer(state, {
      type: 'tool_result',
      name: 'bash',
      toolCallId: 'call-1',
      output: 'command failed',
      resultLength: 14,
      isError: true
    })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.status).toBe('error')
    expect(state.transcript[0]?.text).toContain('Input: {"command":"bad"}')
    expect(state.transcript[0]?.text).toContain('Error: command failed')
    expect(state.activeToolIds).toEqual({})
  })

  it('keeps normal context usage out of transcript noise', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'context_usage',
      used: 42,
      limit: 100,
      state: 'normal'
    })
    state = terminalReducer(state, {
      type: 'usage',
      turnUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
    })

    expect(state.contextUsage).toEqual({ used: 42, limit: 100, state: 'normal' })
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    expect(state.transcript).toHaveLength(0)
  })

  it('keeps model wait heartbeat status out of transcript noise', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'status',
      status: 'thinking',
      text: '正在等待模型响应... 10s'
    })

    expect(state.status).toBe('thinking')
    expect(state.statusText).toBe('正在等待模型响应... 10s')
    expect(state.transcript).toHaveLength(0)
  })

  it('tracks session info for status bar chips without adding transcript noise', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'session_info',
      sessionId: 'session-123456',
      cwd: 'C:\\repo',
      modelName: 'gpt-5.5',
      agentMode: 'normal',
      taskMode: 'task',
      cacheMode: 'auto'
    })

    expect(state.sessionInfo).toEqual({
      sessionId: 'session-123456',
      cwd: 'C:\\repo',
      modelName: 'gpt-5.5',
      agentMode: 'normal',
      taskMode: 'task',
      cacheMode: 'auto'
    })
    expect(state.transcript).toHaveLength(0)
  })

  it('tracks plan entry suggestions without adding transcript noise', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'plan_entry_suggestion',
      request: '完整重构 TUI 输入状态机',
      reason: '任务可能涉及多文件或多阶段修改'
    })

    expect(state.planEntrySuggestion).toEqual({
      request: '完整重构 TUI 输入状态机',
      reason: '任务可能涉及多文件或多阶段修改'
    })
    expect(state.transcript).toHaveLength(0)

    state = terminalReducer(state, { type: 'plan_entry_suggestion_clear' })
    expect(state.planEntrySuggestion).toBeUndefined()
  })

  it('clears plan entry suggestions when the transcript is cleared', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'plan_entry_suggestion',
      request: '迁移配置体系',
      reason: '任务可能涉及多文件或多阶段修改'
    })
    state = terminalReducer(state, { type: 'clear' })

    expect(state.planEntrySuggestion).toBeUndefined()
  })

  it('tracks session picker state without adding transcript noise', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'session_picker',
      currentSessionId: 's1',
      selectedIndex: 1,
      sessions: [
        {
          sessionId: 's1',
          cwd: '/tmp/project',
          projectKey: 'project-1',
          transcriptPath: '/tmp/project/.sessions/s1.jsonl',
          metaPath: '/tmp/project/.sessions/s1.meta.json',
          messageCount: 1,
          tags: []
        },
        {
          sessionId: 's2',
          displayName: 'OAuth 调试',
          cwd: '/tmp/project',
          projectKey: 'project-1',
          transcriptPath: '/tmp/project/.sessions/s2.jsonl',
          metaPath: '/tmp/project/.sessions/s2.meta.json',
          messageCount: 2,
          totalTokens: 1200,
          tags: []
        }
      ]
    })

    expect(state.sessionPicker?.selectedIndex).toBe(1)
    expect(state.sessionPicker?.sessions[1]?.displayName).toBe('OAuth 调试')
    expect(state.transcript).toHaveLength(0)

    state = terminalReducer(state, { type: 'session_picker_close' })
    expect(state.sessionPicker).toBeUndefined()
  })

  it('tracks models picker state without adding transcript noise', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'models_picker',
      models: [
        { id: 'gpt-5.5', displayName: 'GPT-5.5' },
        { id: 'gpt-5.5-mini', displayName: 'GPT-5.5 mini' },
        { id: 'gpt-4.1', displayName: 'GPT-4.1' }
      ],
      selectedIndex: 2,
      activeModelName: 'gpt-5.5',
      endpointLabel: 'https://api.example.com'
    })

    expect(state.modelsPicker?.selectedIndex).toBe(2)
    expect(state.modelsPicker?.models[2]?.id).toBe('gpt-4.1')
    expect(state.modelsPicker?.activeModelName).toBe('gpt-5.5')
    expect(state.transcript).toHaveLength(0)

    state = terminalReducer(state, { type: 'models_picker_close' })
    expect(state.modelsPicker).toBeUndefined()
  })

  it('tracks duck picker state without adding transcript noise', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'duck_picker',
      personas: [
        { id: 'yellow', displayName: '小黄鸭', subtitle: '默认清爽款', themed: false },
        { id: 'shanghai', displayName: '降压鸭', subtitle: '上海码农款', themed: true },
        { id: 'heilongjiang', displayName: '屁老鸭', subtitle: '黑龙江直球款', themed: true }
      ],
      selectedIndex: 1,
      activePersonaId: 'yellow'
    })

    expect(state.duckPicker?.selectedIndex).toBe(1)
    expect(state.duckPicker?.personas[1]?.id).toBe('shanghai')
    expect(state.duckPicker?.activePersonaId).toBe('yellow')
    expect(state.transcript).toHaveLength(0)

    state = terminalReducer(state, { type: 'duck_picker_close' })
    expect(state.duckPicker).toBeUndefined()
  })

  it('keeps status details hidden by default and toggles them without transcript noise', () => {
    let state = createInitialTerminalState()
    expect(state.statusDetailsVisible).toBe(false)

    state = terminalReducer(state, {
      type: 'status_details_visibility',
      visible: true
    })

    expect(state.statusDetailsVisible).toBe(true)
    expect(state.transcript).toHaveLength(0)

    state = terminalReducer(state, { type: 'clear' })
    expect(state.statusDetailsVisible).toBe(true)
  })

  it('logs context usage when state changes into warning or blocking', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'context_usage',
      used: 90,
      limit: 100,
      state: 'warning'
    })

    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.kind).toBe('context')
  })

  it('tracks JIT context and context offloading in terminal state', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'jit_context', text: '工具成本阶梯已生成' })
    state = terminalReducer(state, {
      type: 'context_offload',
      offloaded: 2,
      chars: 24000,
      files: ['/tmp/a.txt']
    })

    expect(state.status).toBe('compacting')
    expect(state.jitMessages.at(-1)).toContain('上下文卸载')
    expect(state.transcript[0]?.kind).toBe('context')
    expect(state.transcript[0]?.meta?.offloadFiles).toEqual(['/tmp/a.txt'])
  })

  it('tracks task progress and background agents separately from transcript', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'progress',
      items: [
        { content: '读代码', status: 'completed' },
        { content: '补测试', activeForm: '正在补测试', status: 'in_progress' }
      ]
    })
    state = terminalReducer(state, {
      type: 'background_agents',
      agents: [
        {
          agentId: 'agent-1',
          agentType: 'reviewer',
          description: 'review',
          status: 'running',
          isolated: true,
          worktreeBranch: 'codex/agent-1'
        }
      ]
    })

    expect(state.progressItems).toHaveLength(2)
    expect(state.backgroundAgents[0]?.worktreeBranch).toBe('codex/agent-1')
    expect(state.transcript).toHaveLength(0)
  })

  it('opens and navigates the agent monitor without transcript noise', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'background_agents',
      agents: [
        {
          agentId: 'agent-old',
          agentType: 'reviewer',
          description: 'old',
          startedAt: '2026-05-29T01:00:00.000Z',
          status: 'completed',
          toolUseCount: 1
        },
        {
          agentId: 'agent-new',
          agentType: 'Explore',
          description: 'new',
          startedAt: '2026-05-29T02:00:00.000Z',
          status: 'running',
          toolUseCount: 2,
          totalTokens: 3200
        }
      ]
    })

    state = terminalReducer(state, { type: 'agent_monitor_open' })
    expect(state.agentMonitor).toMatchObject({
      view: 'list',
      selectedIndex: 0,
      confirmKillAll: false
    })
    expect(state.backgroundAgents).toHaveLength(1)
    expect(state.backgroundAgents[0]?.agentId).toBe('agent-new')

    state = terminalReducer(state, { type: 'agent_monitor_detail', agentId: 'agent-new' })
    expect(state.agentMonitor).toMatchObject({
      view: 'detail',
      agentId: 'agent-new',
      scrollOffset: 0,
      followTail: true,
      outputLineCount: 0
    })

    state = terminalReducer(state, {
      type: 'agent_monitor_output_lines',
      agentId: 'agent-new',
      lineCount: 8
    })
    state = terminalReducer(state, { type: 'agent_monitor_scroll', delta: 2 })
    expect(state.agentMonitor).toMatchObject({
      view: 'detail',
      scrollOffset: 2,
      followTail: false,
      outputLineCount: 8
    })

    state = terminalReducer(state, {
      type: 'agent_monitor_output_lines',
      agentId: 'agent-new',
      lineCount: 11
    })
    expect(state.agentMonitor).toMatchObject({
      view: 'detail',
      scrollOffset: 5,
      followTail: false,
      outputLineCount: 11
    })

    state = terminalReducer(state, { type: 'agent_monitor_follow_tail' })
    expect(state.agentMonitor).toMatchObject({
      view: 'detail',
      scrollOffset: 0,
      followTail: true
    })

    state = terminalReducer(state, { type: 'agent_monitor_back' })
    expect(state.agentMonitor).toMatchObject({
      view: 'list',
      selectedIndex: 0
    })
    state = terminalReducer(state, { type: 'agent_monitor_back' })
    expect(state.agentMonitor).toBeUndefined()
    expect(state.transcript).toHaveLength(0)
  })

  it('keeps agent monitor selection in range when background agents change', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'background_agents',
      agents: [
        {
          agentId: 'agent-1',
          agentType: 'Explore',
          description: 'one',
          status: 'running',
          toolUseCount: 0
        },
        {
          agentId: 'agent-2',
          agentType: 'Explore',
          description: 'two',
          status: 'running',
          toolUseCount: 0
        }
      ]
    })
    state = terminalReducer(state, { type: 'agent_monitor_open' })
    state = terminalReducer(state, { type: 'agent_monitor_select', selectedIndex: 1 })
    state = terminalReducer(state, {
      type: 'background_agents',
      agents: [
        {
          agentId: 'agent-1',
          agentType: 'Explore',
          description: 'one',
          status: 'completed',
          toolUseCount: 0
        }
      ]
    })

    expect(state.backgroundAgents).toEqual([])
    expect(state.agentMonitor).toMatchObject({
      view: 'list',
      selectedIndex: 0
    })
  })

  it('hides completed agents and reconciles detail view when clearing completed agents', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'background_agents',
      agents: [
        {
          agentId: 'agent-completed',
          agentType: 'Explore',
          description: 'done',
          status: 'completed',
          toolUseCount: 1
        },
        {
          agentId: 'agent-failed',
          agentType: 'Explore',
          description: 'failed',
          status: 'failed',
          error: 'boom',
          toolUseCount: 1
        }
      ]
    })

    expect(state.backgroundAgents.map((agent) => agent.agentId)).toEqual(['agent-failed'])

    state = terminalReducer(state, { type: 'agent_monitor_detail', agentId: 'agent-completed' })
    state = terminalReducer(state, { type: 'agent_monitor_clear_completed' })

    expect(state.agentMonitor).toMatchObject({
      view: 'list',
      selectedIndex: 0,
      notice: 'SubAgent agent-completed 已不在列表中。'
    })
  })

  it('moves detail view back to list when selected agent disappears', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'background_agents',
      agents: [
        {
          agentId: 'agent-1',
          agentType: 'Explore',
          description: 'one',
          status: 'running',
          toolUseCount: 0
        }
      ]
    })
    state = terminalReducer(state, { type: 'agent_monitor_detail', agentId: 'agent-1' })
    state = terminalReducer(state, { type: 'background_agents', agents: [] })

    expect(state.agentMonitor).toMatchObject({
      view: 'list',
      selectedIndex: 0,
      notice: 'SubAgent agent-1 已不在列表中。'
    })
  })

  it('tracks stop-all confirmation and lightweight notices in agent monitor', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'agent_monitor_open' })
    state = terminalReducer(state, { type: 'agent_monitor_confirm_kill_all', visible: true })

    expect(state.agentMonitor).toMatchObject({
      view: 'list',
      confirmKillAll: true
    })

    state = terminalReducer(state, { type: 'agent_monitor_notice', text: '当前没有 running Agent 可停止。' })
    expect(state.agentMonitor).toMatchObject({
      view: 'list',
      notice: '当前没有 running Agent 可停止。'
    })
  })

  it('stores tool context cost metadata and recovery hints', () => {
    let state = createInitialTerminalState()
    state = terminalReducer(state, {
      type: 'tool_call',
      name: 'bash',
      input: { command: 'bad' },
      toolCallId: 'call-1',
      contextCost: 'high',
      resultShape: 'command-output'
    })
    state = terminalReducer(state, {
      type: 'tool_result',
      name: 'bash',
      toolCallId: 'call-1',
      isError: true,
      resultLength: 10
    })

    expect(state.status).toBe('recovering')
    expect(state.transcript[0]?.meta).toMatchObject({
      contextCost: 'high',
      resultShape: 'command-output',
      recoveryHint: expect.stringContaining('bash')
    })
  })
})

describe('terminal input state', () => {
  it('supports editing, submit, and history recall', () => {
    let state = createInputState()
    state = insertText(state, 'helo')
    state = moveCursor(state, -1)
    state = insertText(state, 'l')
    state = backspace(state)
    state = insertText(state, 'l')

    const submitted = submitInput(state)
    expect(submitted.input).toBe('hello')

    state = recallPrevious(submitted.state)
    expect(state.value).toBe('hello')
    state = recallNext(state)
    expect(state.value).toBe('')
  })

  it('does not split unicode code points while editing', () => {
    let state = createInputState()
    state = insertText(state, '你🙂好')
    state = moveCursor(state, -1)
    state = backspace(state)

    expect(state.value).toBe('你好')
    expect(renderInputWithCursor(state.value, state.cursor)).toBe('你█好')
    expect(getInputCursorPosition(state.value, state.cursor)).toEqual({ row: 0, column: 2 })
  })

  it('renders input value without fake cursor for IME anchoring', () => {
    expect(renderInputValue('')).toBe(' ')
    expect(renderInputValue('hello')).toBe('hello')
    expect(renderPromptInputRows('a\nb')).toEqual([
      { text: 'a' },
      { text: 'b' }
    ])
    expect(getInputCursorPosition('a\n你b', 3)).toEqual({ row: 1, column: 2 })
    expect(getInputCursorPosition('abcd', 4, 3)).toEqual({ row: 1, column: 1 })
  })

  it('moves the real cursor back onto the rendered input row', () => {
    expect(getCursorRowsFromFrameEnd(2, 1)).toBe(1)
    expect(getCursorRowsFromFrameEnd(5, 2)).toBe(3)
    expect(getCursorRowsFromFrameEnd(1, 2)).toBe(0)
  })

  it('positions the cursor after ZWJ emoji graphemes by display width', () => {
    let state = createInputState()
    state = insertText(state, '🧑‍💻x')
    state = moveCursor(state, -1)

    expect(renderInputWithCursor(state.value, state.cursor)).toBe('🧑‍💻█x')
    expect(getInputCursorPosition(state.value, state.cursor)).toEqual({ row: 0, column: 2 })
  })

  it('normalizes pasted CRLF text into multiline input', () => {
    const state = insertText(createInputState(), 'one\r\ntwo\rthree')

    expect(normalizePastedText('one\r\ntwo\rthree')).toBe('one\ntwo\nthree')
    expect(state.value).toBe('one\ntwo\nthree')
  })

  it('supports reversible escape clear', () => {
    let state = insertText(createInputState(), 'keep this')
    state = clearOrRestoreInput(state)

    expect(state.value).toBe('')
    expect(state.clearedValue).toBe('keep this')

    state = clearOrRestoreInput(state)
    expect(state.value).toBe('keep this')
    expect(state.cursor).toBe('keep this'.length)
    expect(state.clearedValue).toBeUndefined()
  })

  it('searches command history with a stable query', () => {
    let state = createInputState(['pnpm test', 'pnpm typecheck', 'git status'])
    state = insertText(state, 'pnpm')
    state = searchHistoryPrevious(state)

    expect(state.value).toBe('pnpm typecheck')
    expect(state.historySearchQuery).toBe('pnpm')
    expect(state.historySearchMatchIndex).toBe(1)
    expect(state.historySearchMatchCount).toBe(2)

    state = searchHistoryPrevious(state)
    expect(state.value).toBe('pnpm test')
    expect(state.historySearchQuery).toBe('pnpm')
    expect(state.historySearchMatchIndex).toBe(2)
    expect(state.historySearchMatchCount).toBe(2)
  })

  it('wraps Ctrl+R search and supports fuzzy matching', () => {
    let state = insertText(
      createInputState(['pnpm test', 'pnpm typecheck', 'git status']),
      'ptc'
    )

    state = searchHistoryPrevious(state, { mode: 'fuzzy' })
    expect(state.value).toBe('pnpm typecheck')
    expect(state.historySearchMatchIndex).toBe(1)
    expect(state.historySearchMatchCount).toBe(1)

    state = insertText(createInputState(['one pnpm', 'two pnpm']), 'pnpm')
    state = searchHistoryPrevious(state)
    expect(state.value).toBe('two pnpm')
    state = searchHistoryPrevious(state)
    expect(state.value).toBe('one pnpm')
    state = searchHistoryPrevious(state)
    expect(state.value).toBe('two pnpm')
  })

  it('keeps non-consecutive duplicate history but skips consecutive duplicates', () => {
    let state = submitInput(insertText(createInputState(), 'a')).state
    state = submitInput(insertText(state, 'a')).state
    state = submitInput(insertText(state, 'b')).state
    state = submitInput(insertText(state, 'a')).state

    expect(state.history).toEqual(['a', 'b', 'a'])
  })

  it('treats x7f delete events as terminal backspace', () => {
    let state = insertText(createInputState(), 'abc')
    state = moveCursor(state, -1)
    const key = editingKey({ delete: true })

    if (shouldBackspace('', key, '\x7f')) {
      state = backspace(state)
    } else if (shouldDeleteForward(key, '\x7f')) {
      state = deleteForward(state)
    }

    expect(state.value).toBe('ac')
    expect(renderInputWithCursor(state.value, state.cursor)).toBe('a█c')
  })

  it('treats ctrl+h as backspace', () => {
    expect(shouldBackspace('h', editingKey({ ctrl: true }))).toBe(true)
    expect(shouldDeleteForward(editingKey({ ctrl: true }))).toBe(false)
  })

  it('keeps ansi delete as forward delete', () => {
    let state = insertText(createInputState(), 'abc')
    state = moveCursor(state, -1)
    const key = editingKey({ delete: true })

    if (shouldBackspace('', key, '\x1b[3~')) {
      state = backspace(state)
    } else if (shouldDeleteForward(key, '\x1b[3~')) {
      state = deleteForward(state)
    }

    expect(state.value).toBe('ab')
    expect(renderInputWithCursor(state.value, state.cursor)).toBe('ab█')
  })
})

function editingKey(overrides: Partial<Parameters<typeof shouldBackspace>[1]> = {}): Parameters<typeof shouldBackspace>[1] {
  return {
    backspace: false,
    ctrl: false,
    delete: false,
    ...overrides
  }
}

describe('terminal markdown parser', () => {
  it('skips rich markdown parsing for very long assistant output', () => {
    expect(shouldParseMarkdownText('# short')).toBe(true)
    expect(shouldParseMarkdownText('x'.repeat(MARKDOWN_PARSE_CHAR_LIMIT))).toBe(true)
    expect(shouldParseMarkdownText('x'.repeat(MARKDOWN_PARSE_CHAR_LIMIT + 1))).toBe(false)
  })

  it('caps streaming markdown previews to avoid oversized live terminal renders', () => {
    const preview = previewStreamingText(Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n'), 8)

    expect(preview).toContain('内容较长，已折叠 24 行')
    expect(preview).toContain('line 29')
    expect(preview.split('\n')).toHaveLength(8)
  })

  it('caps very long single-line streaming previews by characters', () => {
    const preview = previewStreamingText('x'.repeat(4000), 20)

    expect(preview).toContain('内容较长，已折叠 1400 字符')
    expect(preview.length).toBeLessThan(2700)
  })

  it('parses common markdown blocks used by agent output', () => {
    const blocks = parseMarkdown(
      ['# Title', '', '- one', '- **two**', '', '> note', '', '```ts', 'const x = 1', '```'].join(
        '\n'
      )
    )

    expect(blocks).toMatchObject([
      { type: 'heading', depth: 1, text: 'Title' },
      { type: 'list', ordered: false, items: [{ text: 'one' }, { text: 'two' }] },
      { type: 'quote', text: 'note' },
      { type: 'code', language: 'ts', code: 'const x = 1' }
    ])
    expect(blocks[1]?.type === 'list' ? blocks[1].items[1]?.segments[0]?.type : undefined).toBe('strong')
  })

  it('preserves inline semantics inside blockquotes', () => {
    const blocks = parseMarkdown('> **重点** 见 src/foo.ts:7')

    expect(blocks).toMatchObject([{ type: 'quote', text: '重点 见 src/foo.ts:7' }])
    expect(blocks[0]?.type === 'quote' ? blocks[0].segments.map((segment) => segment.type) : []).toEqual([
      'strong',
      'text',
      'fileRef'
    ])
  })

  it('preserves markdown link targets in terminal text', () => {
    const blocks = parseMarkdown('See [README](README.md).')

    expect(blocks).toMatchObject([{ type: 'paragraph', text: 'See README (README.md).' }])
    expect(blocks[0]?.type === 'paragraph' ? blocks[0].segments[1]?.type : undefined).toBe('fileRef')
  })

  it('treats an unfinished fenced code block as code while streaming', () => {
    const blocks = parseMarkdown(['```ts', 'const value = 1'].join('\n'))

    expect(blocks).toEqual([{ type: 'code', language: 'ts', code: 'const value = 1' }])
  })

  it('parses GitHub-flavored markdown tables', () => {
    const blocks = parseMarkdown(
      [
        '| 包名 | 作用 |',
        '|------|------|',
        '| current-2d-sdk | 主 SDK 入口 |',
        '| @current/renderer | 渲染引擎 |'
      ].join('\n')
    )

    expect(blocks).toMatchObject([
      {
        type: 'table',
        headers: ['包名', '作用'],
        alignments: ['left', 'left'],
        rows: [
          ['current-2d-sdk', '主 SDK 入口'],
          ['@current/renderer', '渲染引擎']
        ]
      }
    ])
  })

  it('uses marked tokenization for table alignment and inline table content', () => {
    const blocks = parseMarkdown(
      [
        '| 名称 | 状态 | 数量 |',
        '|:-----|:----:|-----:|',
        '| **alpha** | [ok](https://example.com) | `42` |'
      ].join('\n')
    )

    expect(blocks).toMatchObject([
      {
        type: 'table',
        headers: ['名称', '状态', '数量'],
        alignments: ['left', 'center', 'right'],
        rows: [['alpha', 'ok (https://example.com)', '42']]
      }
    ])
    expect(blocks[0]?.type === 'table' ? blocks[0].rowSegments[0]?.[0]?.[0]?.type : undefined).toBe('strong')
    expect(blocks[0]?.type === 'table' ? blocks[0].rowSegments[0]?.[1]?.[0]?.type : undefined).toBe('link')
    expect(blocks[0]?.type === 'table' ? blocks[0].rowSegments[0]?.[2]?.[0]?.type : undefined).toBe('inlineCode')
  })

  it('renders task list markers from marked list items', () => {
    const blocks = parseMarkdown(['- [x] 已完成', '- [ ] 待处理'].join('\n'))

    expect(blocks).toMatchObject([
      {
        type: 'list',
        ordered: false,
        items: [{ text: '[x] 已完成' }, { text: '[ ] 待处理' }]
      }
    ])
  })

  it('caps very large markdown tables before they reach Ink rendering', () => {
    const rows = Array.from({ length: 350 }, (_, index) => `| pkg-${index} | desc-${index} |`)
    const blocks = parseMarkdown(['| 包名 | 作用 |', '|------|------|', ...rows].join('\n'))

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'table',
      headers: ['包名', '作用'],
      omittedRows: 50
    })
    if (blocks[0]?.type === 'table') {
      expect(blocks[0].rows).toHaveLength(300)
    }
  })

  it('renders markdown tables as bordered terminal tables with wide text alignment', () => {
    const blocks = parseMarkdown(
      [
        '| 属性 | 说明 |',
        '|------|------|',
        '| currentStage | 当前阶段索引 |',
        '| maxStage | 最大阶段数，当 `currentStage >= maxStage` 时 Jig 结束 |',
        '| initialStage | 起始阶段（默认 0） |'
      ].join('\n')
    )

    expect(blocks[0]?.type).toBe('table')
    if (blocks[0]?.type !== 'table') return

    const table = renderMarkdownTable(blocks[0])
    const lines = [table.top, table.header, table.separator, ...table.rows, table.bottom]

    expect(table.top).toMatch(/^┌─+┬─+┐$/)
    expect(table.header).toContain('│ 属性')
    expect(table.header).toContain('│ 说明')
    expect(table.separator).toMatch(/^├─+┼─+┤$/)
    expect(table.rows[1]).toContain('最大阶段数，当 currentStage >= maxStage 时 Jig 结束')
    expect(table.bottom).toMatch(/^└─+┴─+┘$/)
    expect(new Set(lines.map(stringDisplayWidth)).size).toBe(1)
  })

  it('treats ZWJ emoji as one terminal cell cluster while measuring text', () => {
    expect(stringDisplayWidth('🧑‍💻')).toBe(2)
    expect(stringDisplayWidth('👍🏽')).toBe(2)
  })
})

describe('terminal layout helpers', () => {
  it('formats a startup duck banner for the initial terminal screen', () => {
    const banner = formatStartupDuckBanner()

    expect(banner).toContain('小黄鸭已就位')
    expect(banner).toContain('/mode plan')
    expect(banner).toContain('/ya 换鸭')
    expect(banner).toContain('pnpm run continue')
    expect(banner).not.toContain('/teams')
    expect(STARTUP_DUCK_SOURCE).toBe('startup_duck')
  })

  it('adds the Agent Teams hint to the startup duck banner when enabled', () => {
    const banner = formatStartupDuckBanner({ teamsEnabled: true })

    expect(banner).toContain('/teams 团队')
  })

  it('uses heilongjiang duck line in startup banner when requested', () => {
    const banner = formatStartupDuckBanner({ duckPersona: 'heilongjiang' })
    expect(banner).toContain('屁老鸭已就位')
  })

  it('estimates wrapped rows for long terminal lines', () => {
    expect(estimateWrappedRows('x'.repeat(45), 20)).toBe(3)
    expect(estimateWrappedRows(['short', 'x'.repeat(41)].join('\n'), 20)).toBe(4)
  })

  it('estimates wrapped rows with wide characters', () => {
    expect(estimateWrappedRows('属性说明'.repeat(6), 20)).toBe(3)
  })

  it('clears transcript while preserving slash command suggestions', () => {
    const commands: SlashCommandSuggestion[] = [{ name: '/help', description: 'Show commands' }]
    let state = createInitialTerminalState()
    state = terminalReducer(state, { type: 'slash_commands', commands })
    state = terminalReducer(state, { type: 'message', role: 'user', text: 'hello' })
    state = terminalReducer(state, { type: 'clear' })

    expect(state.transcript).toEqual([])
    expect(state.slashCommands).toEqual(commands)
    expect(state.status).toBe('idle')
  })

  it('hides tool calls from completed turns', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '查一下 skills'),
      transcriptItem('2', 'tool', 'tool', 'Input: {"pattern":"**/SKILL.md"}\nResult: ok'),
      transcriptItem('3', 'tool', 'tool', 'Input: {"pattern":"**/README.md"}\nResult: ok'),
      transcriptItem('4', 'message', 'assistant', '最终回答')
    ]

    const visible = hideCompletedTurnTools(items)
    expect(visible.map((item) => item.id)).toEqual(['1', '4'])
  })

  it('keeps tool calls visible while only intermediate assistant text exists', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '查一下 skills'),
      {
        ...transcriptItem('2', 'message', 'assistant', '我先定位 skills 加载入口。'),
        isStreaming: false,
        meta: { intermediateAssistant: true }
      },
      transcriptItem('3', 'tool', 'tool', 'Input: {"pattern":"loadSkills"}\nResult: ok')
    ]

    const visible = hideCompletedTurnTools(items)
    expect(visible.map((item) => item.id)).toEqual(['1', '2', '3'])
  })

  it('hides completed tool calls after the final assistant answer', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '查一下 skills'),
      {
        ...transcriptItem('2', 'message', 'assistant', '我先定位 skills 加载入口。'),
        isStreaming: false,
        meta: { intermediateAssistant: true }
      },
      transcriptItem('3', 'tool', 'tool', 'Input: {"pattern":"loadSkills"}\nResult: ok'),
      transcriptItem('4', 'message', 'assistant', '最终回答')
    ]

    const visible = hideCompletedTurnTools(items)
    expect(visible.map((item) => item.id)).toEqual(['1', '2', '4'])
  })

  it('keeps assistant text visible while it is still streaming', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '开始'),
      { ...transcriptItem('2', 'message', 'assistant', '流式输出'), isStreaming: true },
      transcriptItem('3', 'tool', 'tool', 'Input: {"pattern":"**/*"}')
    ]

    const visible = hideCompletedTurnTools(items)
    expect(visible.map((item) => item.id)).toContain('2')
  })

  it('splits completed history into static output and keeps current turn live', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '第一轮'),
      transcriptItem('2', 'tool', 'tool', 'Input: {"pattern":"**/*"}'),
      transcriptItem('3', 'message', 'assistant', '第一轮回答'),
      transcriptItem('4', 'message', 'user', '第二轮'),
      { ...transcriptItem('5', 'message', 'assistant', '第二轮流式'), isStreaming: true }
    ]

    const { staticItems, liveItems } = splitStaticAndLiveTranscript(items)

    expect(staticItems.map((item) => item.id)).toEqual(['1', '3'])
    expect(liveItems.map((item) => item.id)).toEqual(['4', '5'])
  })

  it('keeps startup prelude live instead of writing it through static stdout', () => {
    const items = [
      transcriptItem('1', 'message', 'system', '欢迎'),
      transcriptItem('2', 'message', 'assistant', '恢复的历史')
    ]

    const { staticItems, liveItems } = splitStaticAndLiveTranscript(items)

    expect(staticItems).toEqual([])
    expect(liveItems.map((item) => item.id)).toEqual(['1', '2'])
  })

  it('does not move startup prelude into static output after the first user turn', () => {
    const items = [
      transcriptItem('1', 'message', 'system', '启动诊断'),
      transcriptItem('2', 'message', 'user', '问题'),
      transcriptItem('3', 'message', 'assistant', '最终回答')
    ]

    const { staticItems, liveItems } = splitStaticAndLiveTranscript(items)

    expect(staticItems.map((item) => item.id)).toEqual(['2', '3'])
    expect(liveItems).toEqual([])
  })

  it('moves the latest turn to static once it has a final assistant answer', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '问题'),
      transcriptItem('2', 'message', 'assistant', '最终回答')
    ]

    const { staticItems, liveItems } = splitStaticAndLiveTranscript(items)

    expect(staticItems.map((item) => item.id)).toEqual(['1', '2'])
    expect(liveItems).toEqual([])
  })

  it('selects newly static items by id even when capped transcript length is stable', () => {
    const printed = new Set<string>()
    const first = [
      transcriptItem('1', 'message', 'user', '旧问题'),
      transcriptItem('2', 'message', 'assistant', '旧回答')
    ]
    const next = [
      transcriptItem('2', 'message', 'assistant', '旧回答'),
      transcriptItem('3', 'message', 'assistant', '新回答')
    ]

    expect(takeUnprintedStaticItems(first, printed).map((item) => item.id)).toEqual(['1', '2'])
    expect(takeUnprintedStaticItems(next, printed).map((item) => item.id)).toEqual(['3'])
  })

  it('formats static transcript output without relying on Ink Static buffers', () => {
    const output = formatStaticTranscriptItems([
      transcriptItem('1', 'message', 'user', '问题'),
      transcriptItem('2', 'message', 'assistant', '回答')
    ])

    expect(output).toContain('问题')
    expect(output).toContain('▎ 回答')
  })

  it('keeps a tool-only in-progress turn live until the assistant answers', () => {
    const items = [
      transcriptItem('1', 'message', 'user', '查文件'),
      { ...transcriptItem('2', 'tool', 'tool', 'Input: {"path":"README.md"}'), status: 'running' as const }
    ]

    const { staticItems, liveItems } = splitStaticAndLiveTranscript(items)

    expect(staticItems).toEqual([])
    expect(liveItems.map((item) => item.id)).toEqual(['1', '2'])
  })

  it('treats tool calls as one terminal row', () => {
    const item = transcriptItem(
      '1',
      'tool',
      'tool',
      ['Input: {"command":"long-output"}', 'Result: line 1', '... truncated 1000 chars, 10 more lines'].join('\n')
    )

    expect(estimateItemRows(item, 20)).toBe(1)
  })

  it('keeps every completed conversation visible after a new prompt starts', () => {
    const visible = hideCompletedTurnTools([
      transcriptItem('1', 'message', 'user', '再看看skills'),
      transcriptItem('2', 'tool', 'tool', 'Input: {"pattern":"**/SKILL.md"}\nResult: ok'),
      transcriptItem('3', 'message', 'assistant', '上一轮最终回答'),
      transcriptItem('4', 'message', 'user', '读取 src/agents/types.ts 看结构')
    ])

    expect(visible.map((item) => item.text)).toEqual([
      '再看看skills',
      '上一轮最终回答',
      '读取 src/agents/types.ts 看结构'
    ])
  })

  it('does not omit older completed conversations', () => {
    const visible = hideCompletedTurnTools([
      transcriptItem('1', 'message', 'user', '第一轮问题'),
      transcriptItem('2', 'message', 'assistant', '第一轮最终回答'.repeat(20)),
      transcriptItem('3', 'message', 'user', '第二轮问题'),
      transcriptItem('4', 'message', 'assistant', '第二轮最终回答'.repeat(20)),
      transcriptItem('5', 'message', 'user', '当前问题')
    ])

    const visibleText = visible.map((item) => item.text)
    expect(visibleText).toEqual([
      '第一轮问题',
      '第一轮最终回答'.repeat(20),
      '第二轮问题',
      '第二轮最终回答'.repeat(20),
      '当前问题'
    ])
  })
})

function transcriptItem(
  id: string,
  kind: 'message' | 'tool' | 'usage' | 'context',
  role: 'assistant' | 'user' | 'system' | 'tool' | 'error',
  text: string
) {
  return { id, kind, role, text }
}
