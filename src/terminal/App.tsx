/**
 * Ink TUI 根组件：订阅 {@link TerminalEventBus}、管理 transcript 静态/动态分区、
 * 处理键盘输入（含斜杠补全、中断、历史）并回调 `onSubmit` / `onInterrupt` / `onExit`。
 */
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, Static, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import type { TerminalEventBus } from './events'
import { createInitialTerminalState, terminalReducer, type TranscriptItem } from './state'
import {
  backspace,
  clearOrRestoreInput,
  createInputState,
  deleteForward,
  insertText,
  moveCursor,
  newline,
  recallNext,
  recallPrevious,
  replaceRange,
  replaceHistory,
  searchHistoryPrevious,
  submitInput
} from './input'
import { shouldBackspace, shouldDeleteForward } from './keys'
import {
  CommandSuggestions,
  ConversationView,
  Header,
  InputPrompt,
  PlanEntrySuggestion,
  StatusBar
} from './components'
import { formatErrorMessage } from './utils/format'
import { splitStaticAndLiveTranscript, takeUnprintedStaticItems } from './utils/layout'
import {
  filterSlashCommandSuggestions,
  type SlashCommandSuggestion
} from '../slash'
import {
  createEmptyFileMentionIndex,
  fileMentionIndexNotice,
  findFileMentionAtCursor,
  formatFileMentionTarget,
  searchFileMentionIndex,
  type FileMentionIndex,
  type FileMentionIndexStore
} from '../mentions'
import type { SessionSummary } from '../session/store'
import type { HistoryStore } from './history-store'

const ASSISTANT_STREAM_FLUSH_MS = 80
const CLEAR_TERMINAL = '\u001B[2J\u001B[3J\u001B[H'

function escapeDoubleQuotes(value: string): string {
  return value.replaceAll('"', '\\"')
}

/** {@link TerminalApp} 的 props：事件总线与用户输入/生命周期回调。 */
export interface TerminalAppProps {
  /** 终端事件总线，驱动 transcript 与状态栏更新。 */
  bus: TerminalEventBus
  /** 用户按 Enter 提交非空输入时调用。 */
  onSubmit: (input: string) => Promise<void> | void
  onSessionPickerSelect?: (sessionId: string) => Promise<void> | void
  /** 忙碌时 Ctrl+C 首次按下时调用，用于中断当前 Agent 轮次。 */
  onInterrupt?: () => Promise<void> | void
  /** 用户按 Shift+Tab 请求切换 Plan/Normal 模式。 */
  onModeToggle?: () => Promise<void> | void
  /** 用户接受 TUI 内的 Plan Mode 入口建议。 */
  onPlanEntryAccept?: (input: string) => Promise<void> | void
  /** 用户拒绝 TUI 内的 Plan Mode 入口建议，按普通模式继续原请求。 */
  onPlanEntryDecline?: (input: string) => Promise<void> | void
  /** 用户取消 TUI 内的 Plan Mode 入口建议，不执行原请求。 */
  onPlanEntryCancel?: (input: string) => Promise<void> | void
  /** 空闲时 Ctrl+C 或忙碌时连按 Ctrl+C 时调用，随后退出 Ink。 */
  onExit: () => Promise<void> | void
  /** 顶栏标题，默认 `q-code`。 */
  title?: string
  /** 当前会话 ID，显示在顶栏。 */
  sessionId?: string
  /** 工作目录，顶栏以压缩路径展示。 */
  cwd?: string
  /** 斜杠命令补全候选；运行中可被 `slash_commands` 事件覆盖。 */
  slashCommands?: SlashCommandSuggestion[]
  fileMentionIndex?: FileMentionIndex
  fileMentionIndexStore?: FileMentionIndexStore
  inputHistoryStore?: HistoryStore
}

function ModelsPickerPanel({
  picker
}: {
  picker?: {
    models: Array<{ id: string; displayName: string }>
    selectedIndex: number
    activeModelName: string
    endpointLabel: string
  }
}): React.JSX.Element | null {
  if (!picker || picker.models.length === 0) return null
  const selectedModel = picker.models[picker.selectedIndex]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan">
        Models <Text color="gray">({picker.endpointLabel})</Text>
      </Text>
      <Text color="gray">  active: {picker.activeModelName}</Text>
      <Box marginTop={1}>
        <Box width={3}><Text color="yellow"> </Text></Box>
        <Box width={40}><Text color="cyan">Display</Text></Box>
        <Box width={22}><Text color="cyan">ID</Text></Box>
        <Text color="cyan">Status</Text>
      </Box>
      {picker.models.map((model, index) => {
        const selected = index === picker.selectedIndex
        const active = model.id === picker.activeModelName
        return (
          <Box key={model.id}>
            <Box width={3}>
              <Text color={selected ? 'yellow' : 'gray'}>{selected ? '›' : ' '}</Text>
            </Box>
            <Box width={40}>
              <Text color={selected ? 'white' : 'gray'}>{truncate(model.displayName, 38)}</Text>
            </Box>
            <Box width={22}>
              <Text color="gray">{truncate(model.id, 20)}</Text>
            </Box>
            <Text color={active ? 'yellow' : 'gray'}>{active ? 'active' : ''}</Text>
          </Box>
        )
      })}
      <Text color="gray">
        {'  '}↑/↓ 选择 · Enter 切换 (/model) · Esc 关闭
        {selectedModel ? ` · 当前选择: ${selectedModel.id}` : ''}
      </Text>
    </Box>
  )
}

function DuckPickerPanel({
  picker
}: {
  picker?: {
    personas: Array<{
      id: string
      displayName: string
      subtitle: string
      themed: boolean
    }>
    selectedIndex: number
    activePersonaId: string
  }
}): React.JSX.Element | null {
  if (!picker || picker.personas.length === 0) return null
  const selectedPersona = picker.personas[picker.selectedIndex]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan">Ya（鸭子人格）</Text>
      <Text color="gray">  active: {picker.activePersonaId}</Text>
      <Box marginTop={1}>
        <Box width={3}><Text color="yellow"> </Text></Box>
        <Box width={16}><Text color="cyan">Name</Text></Box>
        <Box width={28}><Text color="cyan">Subtitle</Text></Box>
        <Text color="cyan">Type</Text>
      </Box>
      {picker.personas.map((persona, index) => {
        const selected = index === picker.selectedIndex
        const active = persona.id === picker.activePersonaId
        return (
          <Box key={persona.id}>
            <Box width={3}>
              <Text color={selected ? 'yellow' : 'gray'}>{selected ? '›' : ' '}</Text>
            </Box>
            <Box width={16}>
              <Text color={selected ? 'white' : 'gray'}>{truncate(persona.displayName, 14)}</Text>
            </Box>
            <Box width={28}>
              <Text color="gray">{truncate(persona.subtitle, 26)}</Text>
            </Box>
            <Text color={active ? 'yellow' : 'gray'}>
              {active ? 'active' : persona.themed ? 'themed' : 'default'}
            </Text>
          </Box>
        )
      })}
      <Text color="gray">
        {'  '}↑/↓ 选择 · Enter 切换 (/ya) · Esc 关闭
        {selectedPersona ? ` · 当前选择: ${selectedPersona.id}` : ''}
      </Text>
    </Box>
  )
}

function SessionPickerPanel({
  picker,
  renaming
}: {
  picker?: {
    sessions: SessionSummary[]
    selectedIndex: number
    currentSessionId: string
  }
  renaming?: {
    sessionId: string
    value: string
  }
}): React.JSX.Element | null {
  if (!picker || picker.sessions.length === 0) return null
  const selectedSession = picker.sessions[picker.selectedIndex]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box width={3}><Text color="yellow"> </Text></Box>
        <Box width={14}><Text color="cyan">Session</Text></Box>
        <Box width={22}><Text color="cyan">Name</Text></Box>
        <Box width={8}><Text color="cyan">Msgs</Text></Box>
        <Box width={10}><Text color="cyan">Tokens</Text></Box>
        <Text color="cyan">Updated</Text>
      </Box>
      {picker.sessions.map((session, index) => {
        const selected = index === picker.selectedIndex
        const current = session.sessionId === picker.currentSessionId
        return (
          <Box key={session.sessionId}>
            <Box width={3}>
              <Text color={selected ? 'yellow' : 'gray'}>{selected ? '›' : current ? '*' : ' '}</Text>
            </Box>
            <Box width={14}>
              <Text color={selected ? 'yellow' : 'gray'}>{shortSession(session.sessionId)}</Text>
            </Box>
            <Box width={22}>
              <Text color={selected ? 'white' : 'gray'}>{truncate(session.displayName ?? '(无名)', 20)}</Text>
            </Box>
            <Box width={8}><Text color="gray">{String(session.messageCount)}</Text></Box>
            <Box width={10}><Text color="gray">{formatCompactNumber(session.totalTokens ?? session.totalUsage?.totalTokens ?? 0)}</Text></Box>
            <Text color="gray">{formatShortDate(session.updatedAt)}</Text>
          </Box>
        )
      })}
      {renaming && selectedSession && renaming.sessionId === selectedSession.sessionId ? (
        <>
          <Text color="gray">
            {'  '}重命名 {shortSession(selectedSession.sessionId)}：
            <Text color="white">{renaming.value}</Text>
          </Text>
          <Text color="gray">  输入名称 · Enter 确认 · Esc 取消</Text>
        </>
      ) : (
        <Text color="gray">  ↑/↓ 选择 · Enter 切换 · r 重命名 · d 删除 · Esc 关闭</Text>
      )}
    </Box>
  )
}

function shortSession(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatShortDate(value: string | undefined): string {
  if (!value) return '(unknown)'
  return value.replace('T', ' ').slice(0, 16)
}

/**
 * q-code 默认 TUI：Static 区渲染已落盘 transcript，动态区含输入框与状态栏。
 */
export function TerminalApp(props: TerminalAppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(terminalReducer, undefined, createInitialTerminalState)
  const [input, setInput] = useState(() => createInputState())
  const [sessionPickerRenaming, setSessionPickerRenaming] = useState<
    { sessionId: string; value: string } | undefined
  >(undefined)
  const [isBusy, setIsBusy] = useState(false)
  const [interruptRequested, setInterruptRequested] = useState(false)
  const [staticTranscriptItems, setStaticTranscriptItems] = useState<TranscriptItem[]>([])
  const [staticResetKey, setStaticResetKey] = useState(0)
  const { exit } = useApp()
  const { internal_eventEmitter } = useStdin()
  const { stdout } = useStdout()
  const lastRawInput = useRef<string>()
  const pendingAssistantDelta = useRef('')
  const assistantFlushTimer = useRef<ReturnType<typeof setTimeout>>()
  const printedStaticIds = useRef(new Set<string>())
  const { staticItems, liveItems } = useMemo(
    () => splitStaticAndLiveTranscript(state.transcript),
    [state.transcript]
  )
  const hasStreamingAssistant = state.activeAssistantId !== undefined
  const slashCommands =
    state.slashCommands.length > 0 ? state.slashCommands : props.slashCommands ?? []
  const [storedFileMentionIndex, setStoredFileMentionIndex] = useState<FileMentionIndex | undefined>(
    () => props.fileMentionIndexStore?.getSnapshot()
  )
  const fileMentionIndex = useMemo(
    () =>
      props.fileMentionIndex ??
      storedFileMentionIndex ??
      createEmptyFileMentionIndex(props.cwd ?? process.cwd()),
    [props.cwd, props.fileMentionIndex, storedFileMentionIndex]
  )
  const fileMentionAtCursor = useMemo(
    () => findFileMentionAtCursor(input.value, input.cursor),
    [input.cursor, input.value]
  )
  const filteredFileMentions = useMemo(
    () =>
      fileMentionAtCursor
        ? searchFileMentionIndex(fileMentionIndex, fileMentionAtCursor.query)
        : [],
    [fileMentionAtCursor, fileMentionIndex]
  )
  const filteredSlashCommands = useMemo(
    () => filterSlashCommandSuggestions(input.value, slashCommands),
    [input.value, slashCommands]
  )
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1)
  const [selectedFileMentionIndex, setSelectedFileMentionIndex] = useState(-1)
  const historySearchLabel = formatHistorySearchLabel(input)
  const renderedSlashCommands = useMemo(
    () =>
      filteredSlashCommands.map((item, index) => ({
        ...item,
        isSelected: index === selectedCommandIndex
      })),
    [filteredSlashCommands, selectedCommandIndex]
  )
  const renderedFileMentions = useMemo(
    () =>
      filteredFileMentions.map((item, index) => ({
        name: `@${item.path}`,
        description: 'Tab 插入文件引用',
        usage: `@${item.path}`,
        category: '@file',
        isSelected: index === selectedFileMentionIndex
      })),
    [filteredFileMentions, selectedFileMentionIndex]
  )
  const showFileMentions = fileMentionAtCursor !== null && filteredFileMentions.length > 0
  const showSlashCommands = fileMentionAtCursor === null && filteredSlashCommands.length > 0
  const suggestionNotice = fileMentionAtCursor ? fileMentionIndexNotice(fileMentionIndex) : undefined
  const suggestionsVisible = (showFileMentions || showSlashCommands || Boolean(suggestionNotice)) && !isBusy
  const isInteractiveOverlayOpen = Boolean(state.modelsPicker || state.duckPicker || state.sessionPicker)
  const previousSuggestionsVisible = useRef(false)
  const [shouldClearSuggestions, setShouldClearSuggestions] = useState(false)

  useEffect(() => {
    const flushAssistantDelta = () => {
      assistantFlushTimer.current = undefined
      if (!pendingAssistantDelta.current) return
      const text = pendingAssistantDelta.current
      pendingAssistantDelta.current = ''
      dispatch({ type: 'assistant_delta', text })
    }

    const unsubscribe = props.bus.subscribe((event) => {
      if (event.type === 'assistant_delta') {
        pendingAssistantDelta.current += event.text
        if (!assistantFlushTimer.current) {
          assistantFlushTimer.current = setTimeout(flushAssistantDelta, ASSISTANT_STREAM_FLUSH_MS)
        }
        return
      }

      if (event.type === 'assistant_done' || event.type === 'clear') {
        if (assistantFlushTimer.current) {
          clearTimeout(assistantFlushTimer.current)
          assistantFlushTimer.current = undefined
        }
        if (pendingAssistantDelta.current) {
          const text = pendingAssistantDelta.current
          pendingAssistantDelta.current = ''
          dispatch({ type: 'assistant_delta', text })
        }
      }

      if (event.type === 'clear') {
        stdout.write(CLEAR_TERMINAL)
        printedStaticIds.current.clear()
        setStaticTranscriptItems([])
        setStaticResetKey((current) => current + 1)
      }

      dispatch(event)
    })

    return () => {
      unsubscribe()
      if (assistantFlushTimer.current) {
        clearTimeout(assistantFlushTimer.current)
        assistantFlushTimer.current = undefined
      }
      pendingAssistantDelta.current = ''
    }
  }, [props.bus, stdout])

  useEffect(() => {
    if (!isBusy) setInterruptRequested(false)
  }, [isBusy])

  useEffect(() => {
    const pending = takeUnprintedStaticItems(staticItems, printedStaticIds.current)
    if (pending.length === 0) return
    setStaticTranscriptItems((current) => [...current, ...pending])
  }, [staticItems])

  useEffect(() => {
    if (!showSlashCommands) setSelectedCommandIndex(-1)
    if (selectedCommandIndex >= filteredSlashCommands.length) setSelectedCommandIndex(-1)
  }, [filteredSlashCommands.length, selectedCommandIndex, showSlashCommands])

  useEffect(() => {
    if (!showFileMentions) setSelectedFileMentionIndex(-1)
    if (selectedFileMentionIndex >= filteredFileMentions.length) setSelectedFileMentionIndex(-1)
  }, [filteredFileMentions.length, selectedFileMentionIndex, showFileMentions])

  useEffect(() => {
    // 当建议列表从“有”变为“无”时，Ink 在 Windows 终端上偶发无法完整清理上一帧残留文本。
    // 这里强制渲染一帧空白 suggestions 区，确保残留字符（如 `/`）被覆盖。
    if (previousSuggestionsVisible.current && !suggestionsVisible) {
      setShouldClearSuggestions(true)
    }
    previousSuggestionsVisible.current = suggestionsVisible
  }, [suggestionsVisible])

  useEffect(() => {
    if (!shouldClearSuggestions) return
    // 只渲染一帧空白用于覆盖残留字符。
    setShouldClearSuggestions(false)
  }, [shouldClearSuggestions])

  useEffect(() => {
    const rememberRawInput = (data: Buffer | string) => {
      lastRawInput.current = Buffer.isBuffer(data) ? data.toString() : data
    }
    internal_eventEmitter.prependListener('input', rememberRawInput)
    return () => {
      internal_eventEmitter.removeListener('input', rememberRawInput)
    }
  }, [internal_eventEmitter])

  useEffect(() => {
    const store = props.fileMentionIndexStore
    if (!store) {
      setStoredFileMentionIndex(undefined)
      return undefined
    }
    setStoredFileMentionIndex(store.getSnapshot())
    return store.subscribe((index) => setStoredFileMentionIndex(index))
  }, [props.fileMentionIndexStore])

  useEffect(() => {
    const store = props.inputHistoryStore
    if (!store) return undefined

    let cancelled = false
    const reload = () => {
      void store
        .load()
        .then((history) => {
          if (!cancelled) setInput((current) => replaceHistory(current, history))
        })
        .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
    }
    reload()
    const unsubscribe = store.subscribe(reload)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [props.inputHistoryStore])

  useInput((value, key) => {
    const rawInput = lastRawInput.current
    const isCtrlC = key.ctrl && value === 'c'
    const isShiftTab = key.tab && key.shift
    const isMultilineShortcut =
      (key.ctrl && (value === 'j' || value === '\n')) || (key.meta && key.return)

    if (isShiftTab && !isBusy && !isInteractiveOverlayOpen && !suggestionsVisible) {
      setIsBusy(true)
      void Promise.resolve(props.onModeToggle?.())
        .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
        .finally(() => setIsBusy(false))
      return
    }

    if (state.planEntrySuggestion && !isBusy) {
      const request = state.planEntrySuggestion.request
      if (key.return) {
        dispatch({ type: 'plan_entry_suggestion_clear' })
        setIsBusy(true)
        void Promise.resolve(props.onPlanEntryAccept?.(request))
          .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
          .finally(() => setIsBusy(false))
        return
      }
      if (key.escape) {
        dispatch({ type: 'plan_entry_suggestion_clear' })
        setIsBusy(true)
        void Promise.resolve(props.onPlanEntryDecline?.(request))
          .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
          .finally(() => setIsBusy(false))
        return
      }
      if (isCtrlC) {
        dispatch({ type: 'plan_entry_suggestion_clear' })
        void Promise.resolve(props.onPlanEntryCancel?.(request))
          .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
        return
      }
      return
    }

    if (isBusy && !isCtrlC) return

    if (state.modelsPicker && !isBusy) {
      if (key.upArrow) {
        const count = state.modelsPicker.models.length
        if (count > 0) {
          const selectedIndex =
            state.modelsPicker.selectedIndex <= 0 ? count - 1 : state.modelsPicker.selectedIndex - 1
          dispatch({
            type: 'models_picker',
            models: state.modelsPicker.models,
            selectedIndex,
            activeModelName: state.modelsPicker.activeModelName,
            endpointLabel: state.modelsPicker.endpointLabel
          })
        }
        return
      }
      if (key.downArrow) {
        const count = state.modelsPicker.models.length
        if (count > 0) {
          const selectedIndex =
            state.modelsPicker.selectedIndex >= count - 1 ? 0 : state.modelsPicker.selectedIndex + 1
          dispatch({
            type: 'models_picker',
            models: state.modelsPicker.models,
            selectedIndex,
            activeModelName: state.modelsPicker.activeModelName,
            endpointLabel: state.modelsPicker.endpointLabel
          })
        }
        return
      }
      if (key.escape) {
        dispatch({ type: 'models_picker_close' })
        return
      }
      if (key.return) {
        const selected = state.modelsPicker.models[state.modelsPicker.selectedIndex]
        dispatch({ type: 'models_picker_close' })
        if (selected) {
          setIsBusy(true)
          void Promise.resolve(props.onSubmit(`/model ${selected.id}`))
            .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
            .finally(() => setIsBusy(false))
        }
        return
      }

      // models picker 打开期间，禁止向输入框写入普通字符。
      return
    }

    if (state.duckPicker && !isBusy) {
      if (key.upArrow) {
        const count = state.duckPicker.personas.length
        if (count > 0) {
          const selectedIndex =
            state.duckPicker.selectedIndex <= 0 ? count - 1 : state.duckPicker.selectedIndex - 1
          dispatch({
            type: 'duck_picker',
            personas: state.duckPicker.personas,
            selectedIndex,
            activePersonaId: state.duckPicker.activePersonaId
          })
        }
        return
      }
      if (key.downArrow) {
        const count = state.duckPicker.personas.length
        if (count > 0) {
          const selectedIndex =
            state.duckPicker.selectedIndex >= count - 1 ? 0 : state.duckPicker.selectedIndex + 1
          dispatch({
            type: 'duck_picker',
            personas: state.duckPicker.personas,
            selectedIndex,
            activePersonaId: state.duckPicker.activePersonaId
          })
        }
        return
      }
      if (key.escape) {
        dispatch({ type: 'duck_picker_close' })
        return
      }
      if (key.return) {
        const selected = state.duckPicker.personas[state.duckPicker.selectedIndex]
        dispatch({ type: 'duck_picker_close' })
        if (selected) {
          setIsBusy(true)
          void Promise.resolve(props.onSubmit(`/ya ${selected.id}`))
            .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
            .finally(() => setIsBusy(false))
        }
        return
      }

      return
    }

    if (state.sessionPicker && !isBusy) {
      // session picker 的重命名输入模式：接管按键，不写入底部输入框。
      if (sessionPickerRenaming) {
        if (key.escape) {
          setSessionPickerRenaming(undefined)
          return
        }
        if (key.return) {
          const name = sessionPickerRenaming.value.trim()
          const targetId = sessionPickerRenaming.sessionId
          setSessionPickerRenaming(undefined)
          dispatch({ type: 'session_picker_close' })
          if (name) {
            setIsBusy(true)
            void Promise.resolve(
              props.onSubmit(`/sessions rename ${targetId} "${escapeDoubleQuotes(name)}"`),
            )
              .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
              .finally(() => setIsBusy(false))
          }
          return
        }
        if (shouldBackspace(value, key, rawInput)) {
          setSessionPickerRenaming((current) =>
            current ? { ...current, value: current.value.slice(0, -1) } : current,
          )
          return
        }
        if (value && !key.ctrl && !key.meta) {
          setSessionPickerRenaming((current) =>
            current ? { ...current, value: current.value + value } : current,
          )
        }
        return
      }

      if (key.upArrow) {
        const count = state.sessionPicker.sessions.length
        if (count > 0) {
          const selectedIndex =
            state.sessionPicker.selectedIndex <= 0
              ? count - 1
              : state.sessionPicker.selectedIndex - 1
          dispatch({
            type: 'session_picker',
            sessions: state.sessionPicker.sessions,
            selectedIndex,
            currentSessionId: state.sessionPicker.currentSessionId
          })
        }
        return
      }
      if (key.downArrow) {
        const count = state.sessionPicker.sessions.length
        if (count > 0) {
          const selectedIndex =
            state.sessionPicker.selectedIndex >= count - 1
              ? 0
              : state.sessionPicker.selectedIndex + 1
          dispatch({
            type: 'session_picker',
            sessions: state.sessionPicker.sessions,
            selectedIndex,
            currentSessionId: state.sessionPicker.currentSessionId
          })
        }
        return
      }
      if (key.escape) {
        dispatch({ type: 'session_picker_close' })
        setSessionPickerRenaming(undefined)
        return
      }
      if (key.return) {
        const selected = state.sessionPicker.sessions[state.sessionPicker.selectedIndex]
        dispatch({ type: 'session_picker_close' })
        if (selected) {
          setSessionPickerRenaming(undefined)
          setIsBusy(true)
          void Promise.resolve(props.onSessionPickerSelect?.(selected.sessionId))
            .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
            .finally(() => setIsBusy(false))
        }
        return
      }

      if (!key.ctrl && !key.meta && (value === 'r' || value === 'R')) {
        const selected = state.sessionPicker.sessions[state.sessionPicker.selectedIndex]
        if (selected) {
          setSessionPickerRenaming({
            sessionId: selected.sessionId,
            value:
              selected.displayName && selected.displayName !== '(无名)'
                ? selected.displayName
                : ''
          })
        }
        return
      }

      if (!key.ctrl && !key.meta && (value === 'd' || value === 'D')) {
        const selected = state.sessionPicker.sessions[state.sessionPicker.selectedIndex]
        dispatch({ type: 'session_picker_close' })
        if (selected) {
          setSessionPickerRenaming(undefined)
          setIsBusy(true)
          void Promise.resolve(props.onSubmit(`/sessions delete ${selected.sessionId}`))
            .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
            .finally(() => setIsBusy(false))
        }
        return
      }

      // session picker 打开期间，禁止向输入框写入普通字符。
      // 仅允许方向键/Enter/Esc 进行选择与关闭。
      return
    }

    if (isCtrlC && isBusy) {
      if (interruptRequested) {
        void Promise.resolve(props.onExit()).finally(() => exit())
        return
      }
      setInterruptRequested(true)
      dispatch({ type: 'message', role: 'system', text: '正在中断当前任务...' })
      void Promise.resolve(props.onInterrupt?.()).catch((error) => {
        dispatch({ type: 'error', text: formatErrorMessage(error) })
      })
      return
    }

    if (isCtrlC) {
      void Promise.resolve(props.onExit()).finally(() => exit())
      return
    }

    if (key.ctrl && value === 'r') {
      setInput((current) =>
        searchHistoryPrevious(current, {
          mode: props.inputHistoryStore?.getSearchMode() ?? 'substring'
        })
      )
      return
    }

    if (showFileMentions && fileMentionAtCursor) {
      if (key.upArrow) {
        setSelectedFileMentionIndex((current) =>
          current <= 0 ? filteredFileMentions.length - 1 : current - 1
        )
        return
      }
      if (key.downArrow) {
        setSelectedFileMentionIndex((current) =>
          current >= filteredFileMentions.length - 1 ? 0 : current + 1
        )
        return
      }
      if (key.tab || (key.return && selectedFileMentionIndex >= 0)) {
        const selected = filteredFileMentions[
          selectedFileMentionIndex >= 0 ? selectedFileMentionIndex : 0
        ]
        if (selected) {
          setInput((current) =>
            replaceRange(current, fileMentionAtCursor.start, fileMentionAtCursor.end, `${formatFileMentionTarget(selected.path)} `)
          )
          setSelectedFileMentionIndex(-1)
          return
        }
      }
    }

    if (showSlashCommands) {
      if (key.upArrow) {
        setSelectedCommandIndex((current) =>
          current <= 0 ? filteredSlashCommands.length - 1 : current - 1
        )
        return
      }
      if (key.downArrow) {
        setSelectedCommandIndex((current) =>
          current >= filteredSlashCommands.length - 1 ? 0 : current + 1
        )
        return
      }
      if (key.tab || (key.return && selectedCommandIndex >= 0)) {
        const selected = filteredSlashCommands[
          selectedCommandIndex >= 0 ? selectedCommandIndex : 0
        ]
        if (selected) {
          setInput((current) => ({
            ...current,
            value: `${selected.name} `,
            cursor: selected.name.length + 1,
            historyIndex: undefined
          }))
          setSelectedCommandIndex(-1)
          return
        }
      }
    }

    if (key.return) {
      if (isMultilineShortcut) {
        setInput((current) => newline(current))
        return
      }
      const shouldRecord = (value: string) => props.inputHistoryStore?.shouldRecord(value) ?? true
      const submitted = submitInput(input, {
        shouldRecord,
        maxHistory: props.inputHistoryStore?.getRuntimeLimit()
      })
      const text = submitted.input.trim()
      setInput(submitted.state)
      if (!text) return
      if (shouldRecord(submitted.input)) {
        void props.inputHistoryStore
          ?.append(submitted.input)
          .catch((error) => dispatch({ type: 'error', text: formatErrorMessage(error) }))
      }
      dispatch({ type: 'message', role: 'user', text })
      setIsBusy(true)
      setInterruptRequested(false)
      void Promise.resolve(props.onSubmit(text))
        .catch((error) => {
          dispatch({ type: 'error', text: formatErrorMessage(error) })
        })
        .finally(() => {
          setIsBusy(false)
        })
      return
    }

    if (isMultilineShortcut) {
      setInput((current) => newline(current))
      return
    }

    if (shouldBackspace(value, key, rawInput)) {
      setInput((current) => backspace(current))
      return
    }
    if (shouldDeleteForward(key, rawInput)) {
      setInput((current) => deleteForward(current))
      return
    }
    if (key.leftArrow) {
      setInput((current) => moveCursor(current, -1))
      return
    }
    if (key.rightArrow) {
      setInput((current) => moveCursor(current, 1))
      return
    }
    if (key.upArrow) {
      setInput((current) => recallPrevious(current))
      return
    }
    if (key.downArrow) {
      setInput((current) => recallNext(current))
      return
    }
    if (key.escape) {
      setInput((current) => clearOrRestoreInput(current))
      return
    }
    if (value && !key.ctrl && !key.meta) {
      setInput((current) => insertText(current, value))
    }
  })

  return (
    <>
      <Static key={staticResetKey} items={staticTranscriptItems}>
        {(item) => <ConversationView key={item.id} items={[item]} />}
      </Static>
      <Box flexDirection="column" paddingX={1}>
        <Header
          title={props.title ?? 'q-code'}
          sessionId={state.sessionInfo?.sessionId ?? props.sessionId}
          cwd={state.sessionInfo?.cwd ?? props.cwd}
        />
        <ConversationView items={liveItems} />
        <StatusBar state={state} isBusy={isBusy} hasStreamingAssistant={hasStreamingAssistant} />
        <SessionPickerPanel picker={state.sessionPicker} renaming={sessionPickerRenaming} />
        <ModelsPickerPanel picker={state.modelsPicker} />
        <DuckPickerPanel picker={state.duckPicker} />
        <PlanEntrySuggestion suggestion={state.planEntrySuggestion} />
        {suggestionsVisible ? (
          <CommandSuggestions
            suggestions={showFileMentions ? renderedFileMentions : renderedSlashCommands}
            notice={suggestionNotice}
          />
        ) : shouldClearSuggestions ? (
          <Box marginTop={1}><Text> </Text></Box>
        ) : null}
        <InputPrompt
          value={input.value}
          cursor={input.cursor}
          isBusy={
            isBusy ||
            state.sessionPicker !== undefined ||
            sessionPickerRenaming !== undefined ||
            state.modelsPicker !== undefined ||
            state.duckPicker !== undefined
          }
          useRealCursor={process.env.Q_CODE_TUI_CURSOR?.trim().toLowerCase() === 'ansi'}
          historySearchLabel={historySearchLabel}
          hasUndoClear={!input.value && input.clearedValue !== undefined}
        />
      </Box>
    </>
  )
}

function formatHistorySearchLabel(input: ReturnType<typeof createInputState>): string | undefined {
  if (input.historySearchQuery === undefined) return undefined
  if (input.historySearchMatchIndex && input.historySearchMatchCount) {
    return `Ctrl+R 历史搜索中 (${input.historySearchMatchIndex}/${input.historySearchMatchCount})`
  }
  return 'Ctrl+R 历史搜索中'
}
