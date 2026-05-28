/**
 * TUI 输入光标模式检测：IDE 集成终端默认用内联光标，避免 ANSI 光标同步错位/抖动。
 */
export type PromptCursorMode = 'ansi' | 'inline' | 'off'

export interface PromptCursorModeContext {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/** 解析用户显式配置的 TUI 输入光标模式。 */
export function parsePromptCursorMode(value: string | undefined): PromptCursorMode | 'auto' | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'ansi' || normalized === 'native') return 'ansi'
  if (normalized === 'inline' || normalized === 'block') return 'inline'
  if (normalized === 'off' || normalized === 'none' || normalized === 'hidden') return 'off'
  if (normalized === 'auto') return 'auto'
  return undefined
}

/** 返回当前终端应使用的输入光标模式。 */
export function detectPromptCursorMode(
  context: PromptCursorModeContext = {}
): PromptCursorMode {
  const env = context.env ?? process.env
  const configured = parsePromptCursorMode(env.Q_CODE_TUI_CURSOR)
  if (configured && configured !== 'auto') return configured
  if (isIntegratedIdeTerminal(env)) return 'inline'
  return 'ansi'
}

/** 判断是否处于 VSCode/Cursor/Windsurf/Trae/JetBrains 等 IDE 集成终端。 */
export function isIntegratedIdeTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = normalize(env.TERM_PROGRAM)
  const terminalEmulator = normalize(env.TERMINAL_EMULATOR)
  const vscodeInjection = normalize(env.VSCODE_INJECTION)
  const appName = normalize(env.TERM_PROGRAM_VERSION) + ' ' + normalize(env.__CFBundleIdentifier)

  return (
    termProgram === 'vscode' ||
    termProgram === 'cursor' ||
    termProgram === 'windsurf' ||
    termProgram === 'trae' ||
    terminalEmulator.includes('jetbrains') ||
    terminalEmulator.includes('intellij') ||
    vscodeInjection === '1' ||
    hasAnyEnv(env, [
      'VSCODE_PID',
      'VSCODE_CWD',
      'VSCODE_IPC_HOOK_CLI',
      'CURSOR_TRACE_ID',
      'WINDSURF_BIN',
      'TRAE_IDE',
      'TERMINAL_EMULATOR'
    ]) && (
      termProgram === 'vscode' ||
      appName.includes('jetbrains') ||
      terminalEmulator.includes('jetbrains')
    )
  )
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function hasAnyEnv(env: NodeJS.ProcessEnv, names: string[]): boolean {
  return names.some((name) => Boolean(env[name]?.trim()))
}
