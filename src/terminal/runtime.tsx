/**
 * Ink 运行时封装：创建 {@link InMemoryTerminalEventBus}、挂载 {@link TerminalApp}，
 * 并向 CLI 主循环暴露 `print` / `emit` / `waitUntilExit`。
 */
import React from 'react'
import { render, type Instance } from 'ink'
import { InMemoryTerminalEventBus, type TerminalEvent, type TerminalEventBus } from './events'
import { TerminalApp } from './App'
import type { SlashCommandSuggestion } from '../slash'
import type { FileMentionIndex, FileMentionIndexStore } from '../mentions'
import type { HistoryStore } from './history-store'

/** {@link startTerminalRuntime} 的启动选项。 */
export interface TerminalRuntimeOptions {
  title?: string
  sessionId?: string
  cwd?: string
  /** 渲染前预灌入的事件（如启动横幅）。 */
  initialEvents?: TerminalEvent[]
  slashCommands?: SlashCommandSuggestion[]
  fileMentionIndex?: FileMentionIndex
  fileMentionIndexStore?: FileMentionIndexStore
  inputHistoryStore?: HistoryStore
  onSubmit: (input: string) => Promise<void> | void
  onSessionPickerSelect?: (sessionId: string) => Promise<void> | void
  onInterrupt?: () => Promise<void> | void
  onModeToggle?: () => Promise<void> | void
  onPlanEntryAccept?: (input: string) => Promise<void> | void
  onPlanEntryDecline?: (input: string) => Promise<void> | void
  onPlanEntryCancel?: (input: string) => Promise<void> | void
  onExit: () => Promise<void> | void
}

/** 已启动的 Ink 终端运行时句柄。 */
export interface TerminalRuntime {
  bus: TerminalEventBus
  instance: Instance
  /** 以 system 消息写入 transcript。 */
  print(text: string): void
  emit(event: TerminalEvent): void
  /** 等待用户退出 TUI（Ink `waitUntilExit`）。 */
  waitUntilExit(): Promise<void>
}

/**
 * 启动 Ink TUI 并返回可与 `index.ts` 主循环对接的运行时句柄。
 */
export function startTerminalRuntime(options: TerminalRuntimeOptions): TerminalRuntime {
  const bus = new InMemoryTerminalEventBus()
  for (const event of options.initialEvents ?? []) bus.emit(event)
  const instance = render(
    <TerminalApp
      bus={bus}
      title={options.title}
      sessionId={options.sessionId}
      cwd={options.cwd}
      slashCommands={options.slashCommands}
      fileMentionIndex={options.fileMentionIndex}
      fileMentionIndexStore={options.fileMentionIndexStore}
      inputHistoryStore={options.inputHistoryStore}
      onSubmit={options.onSubmit}
      onSessionPickerSelect={options.onSessionPickerSelect}
      onInterrupt={options.onInterrupt}
      onModeToggle={options.onModeToggle}
      onPlanEntryAccept={options.onPlanEntryAccept}
      onPlanEntryDecline={options.onPlanEntryDecline}
      onPlanEntryCancel={options.onPlanEntryCancel}
      onExit={options.onExit}
    />,
    {
      patchConsole: true,
      exitOnCtrlC: false
    }
  )

  return {
    bus,
    instance,
    print: (text) => bus.emit({ type: 'message', role: 'system', text }),
    emit: (event) => bus.emit(event),
    waitUntilExit: () => instance.waitUntilExit()
  }
}
