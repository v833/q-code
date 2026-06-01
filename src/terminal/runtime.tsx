/**
 * Ink 运行时封装：创建 {@link InMemoryTerminalEventBus}、挂载 {@link TerminalApp}，
 * 并向 CLI 主循环暴露 `print` / `emit` / `waitUntilExit`。
 */
import React from 'react'
import { render } from 'ink'
import { InMemoryTerminalEventBus, type TerminalRuntime, type TerminalRuntimeOptions } from './events'
import { TerminalApp } from './App'

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
      cursorModeDecision={options.cursorModeDecision}
      onSubmit={options.onSubmit}
      onSessionPickerSelect={options.onSessionPickerSelect}
      onAgentKill={options.onAgentKill}
      onAgentKillAll={options.onAgentKillAll}
      onAgentClearCompleted={options.onAgentClearCompleted}
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
