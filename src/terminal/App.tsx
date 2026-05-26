import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, Static, useApp, useInput, useStdin, useStdout } from 'ink'
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
  searchHistoryPrevious,
  submitInput
} from './input'
import { shouldBackspace, shouldDeleteForward } from './keys'
import {
  CommandSuggestions,
  ConversationView,
  Header,
  InputPrompt,
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
  type FileMentionIndex
} from '../mentions'

const ASSISTANT_STREAM_FLUSH_MS = 80
const CLEAR_TERMINAL = '\u001B[2J\u001B[3J\u001B[H'

export interface TerminalAppProps {
  bus: TerminalEventBus
  onSubmit: (input: string) => Promise<void> | void
  onInterrupt?: () => Promise<void> | void
  onExit: () => Promise<void> | void
  title?: string
  sessionId?: string
  cwd?: string
  slashCommands?: SlashCommandSuggestion[]
  fileMentionIndex?: FileMentionIndex
}

export function TerminalApp(props: TerminalAppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(terminalReducer, undefined, createInitialTerminalState)
  const [input, setInput] = useState(() => createInputState())
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
  const fileMentionIndex = useMemo(
    () => props.fileMentionIndex ?? createEmptyFileMentionIndex(props.cwd ?? process.cwd()),
    [props.cwd, props.fileMentionIndex]
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
    const rememberRawInput = (data: Buffer | string) => {
      lastRawInput.current = Buffer.isBuffer(data) ? data.toString() : data
    }
    internal_eventEmitter.prependListener('input', rememberRawInput)
    return () => {
      internal_eventEmitter.removeListener('input', rememberRawInput)
    }
  }, [internal_eventEmitter])

  useInput((value, key) => {
    const rawInput = lastRawInput.current
    const isCtrlC = key.ctrl && value === 'c'
    const isMultilineShortcut =
      (key.return && key.shift) || (key.ctrl && (value === 'j' || value === '\n')) || (key.meta && key.return)

    if (isBusy && !isCtrlC) return

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
      setInput((current) => searchHistoryPrevious(current))
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
      const submitted = submitInput(input)
      const text = submitted.input.trim()
      setInput(submitted.state)
      if (!text) return
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
        <Header title={props.title ?? 'q-code'} sessionId={props.sessionId} cwd={props.cwd} />
        <ConversationView items={liveItems} />
        <StatusBar state={state} isBusy={isBusy} hasStreamingAssistant={hasStreamingAssistant} />
        <CommandSuggestions
          suggestions={showFileMentions ? renderedFileMentions : renderedSlashCommands}
          notice={suggestionNotice}
        />
        <InputPrompt
          value={input.value}
          cursor={input.cursor}
          isBusy={isBusy}
          isHistorySearch={input.historySearchQuery !== undefined}
          hasUndoClear={!input.value && input.clearedValue !== undefined}
        />
      </Box>
    </>
  )
}
