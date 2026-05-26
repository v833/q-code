import React from 'react'
import { render, type Instance } from 'ink'
import { InMemoryTerminalEventBus, type TerminalEvent, type TerminalEventBus } from './events'
import { TerminalApp } from './App'
import type { SlashCommandSuggestion } from '../slash'
import type { FileMentionIndex } from '../mentions'

export interface TerminalRuntimeOptions {
  title?: string
  sessionId?: string
  cwd?: string
  initialEvents?: TerminalEvent[]
  slashCommands?: SlashCommandSuggestion[]
  fileMentionIndex?: FileMentionIndex
  onSubmit: (input: string) => Promise<void> | void
  onInterrupt?: () => Promise<void> | void
  onExit: () => Promise<void> | void
}

export interface TerminalRuntime {
  bus: TerminalEventBus
  instance: Instance
  print(text: string): void
  emit(event: TerminalEvent): void
  waitUntilExit(): Promise<void>
}

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
      onSubmit={options.onSubmit}
      onInterrupt={options.onInterrupt}
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
