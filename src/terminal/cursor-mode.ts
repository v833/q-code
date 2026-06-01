/**
 * TUI 输入光标策略：基于终端能力画像选择真实 ANSI 光标、内联文本光标或关闭光标。
 */
import {
  detectTerminalCapabilities,
  isIntegratedIdeTerminal,
  type TerminalCapabilities
} from './terminal-capabilities'

export type PromptCursorMode = 'ansi' | 'inline' | 'off'

export interface PromptCursorModeContext {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  isTTY?: boolean
}

export interface PromptCursorModeDecision {
  mode: PromptCursorMode
  source: 'override' | 'auto'
  reason: string
  capabilities: TerminalCapabilities
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
  return detectPromptCursorModeDecision(context).mode
}

/** 返回 cursor mode 与可打印诊断原因。 */
export function detectPromptCursorModeDecision(
  context: PromptCursorModeContext = {}
): PromptCursorModeDecision {
  const env = context.env ?? process.env
  const configured = parsePromptCursorMode(env.Q_CODE_TUI_CURSOR)
  const capabilities = detectTerminalCapabilities(context)

  if (configured && configured !== 'auto') {
    return {
      mode: configured,
      source: 'override',
      reason: `Q_CODE_TUI_CURSOR=${configured}`,
      capabilities
    }
  }

  if (capabilities.riskFlags.includes('non-tty') || capabilities.riskFlags.includes('ci')) {
    return {
      mode: 'off',
      source: 'auto',
      reason: `${capabilities.reason}; non-interactive terminal`,
      capabilities
    }
  }
  if (capabilities.riskFlags.includes('ide-integrated')) {
    return {
      mode: 'inline',
      source: 'auto',
      reason: `${capabilities.reason}; IDE integrated terminals avoid ANSI cursor chasing`,
      capabilities
    }
  }
  if (
    capabilities.platformKind === 'windows-conpty' &&
    capabilities.riskFlags.includes('cursor-sync-unstable')
  ) {
    return {
      mode: 'inline',
      source: 'auto',
      reason: `${capabilities.reason}; Windows ConPTY risk without known stable host`,
      capabilities
    }
  }
  return {
    mode: 'ansi',
    source: 'auto',
    reason: `${capabilities.reason}; plain terminal keeps native cursor`,
    capabilities
  }
}

export { isIntegratedIdeTerminal }
