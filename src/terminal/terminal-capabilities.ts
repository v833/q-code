/**
 * 终端能力画像：把环境变量与平台信息归一化为 TUI 输入光标策略可消费的稳定信号。
 */

export type TerminalHostKind =
  | 'vscode-compatible'
  | 'jetbrains'
  | 'windows-terminal'
  | 'git-bash'
  | 'iterm2'
  | 'apple-terminal'
  | 'wezterm'
  | 'ghostty'
  | 'alacritty'
  | 'conemu'
  | 'ci'
  | 'unknown'

export type TerminalEmulatorKind =
  | 'xtermjs'
  | 'jediterm'
  | 'windows-terminal'
  | 'mintty'
  | 'native'
  | 'unknown'

export type TerminalPlatformKind = 'windows-conpty' | 'wsl' | 'unix' | 'unknown'

export type TerminalRiskFlag =
  | 'ide-integrated'
  | 'cursor-sync-unstable'
  | 'soft-wrap-sensitive'
  | 'non-tty'
  | 'ci'

export interface TerminalCapabilitiesContext {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  isTTY?: boolean
}

export interface TerminalCapabilities {
  hostKind: TerminalHostKind
  emulatorKind: TerminalEmulatorKind
  platformKind: TerminalPlatformKind
  riskFlags: TerminalRiskFlag[]
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

/** 识别当前终端宿主、平台和已知 TUI 输入风险。 */
export function detectTerminalCapabilities(
  context: TerminalCapabilitiesContext = {}
): TerminalCapabilities {
  const env = context.env ?? process.env
  const platform = context.platform ?? process.platform
  const termProgram = normalize(env.TERM_PROGRAM)
  const terminalEmulator = normalize(env.TERMINAL_EMULATOR)
  const bundleId = normalize(env.__CFBundleIdentifier)
  const platformKind = detectPlatformKind(env, platform)
  const isTTY = context.isTTY ?? true

  const hostKind = detectHostKind(env)
  const emulatorKind = detectEmulatorKind({
    env,
    hostKind,
    termProgram,
    terminalEmulator,
    bundleId
  })
  const riskFlags = new Set<TerminalRiskFlag>()

  if (!isTTY) riskFlags.add('non-tty')
  if (isCi(env)) riskFlags.add('ci')
  if (hostKind === 'vscode-compatible' || hostKind === 'jetbrains') {
    riskFlags.add('ide-integrated')
    riskFlags.add('cursor-sync-unstable')
    riskFlags.add('soft-wrap-sensitive')
  }
  if (
    platformKind === 'windows-conpty' &&
    hostKind !== 'windows-terminal' &&
    hostKind !== 'git-bash'
  ) {
    riskFlags.add('cursor-sync-unstable')
    riskFlags.add('soft-wrap-sensitive')
  }

  return {
    hostKind,
    emulatorKind,
    platformKind,
    riskFlags: [...riskFlags],
    confidence: hostKind === 'unknown' ? 'low' : 'high',
    reason: createCapabilityReason({
      env,
      hostKind,
      emulatorKind,
      platformKind,
      riskFlags: [...riskFlags]
    })
  }
}

/** 判断是否为 IDE 集成终端。 */
export function isIntegratedIdeTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  const hostKind = detectTerminalCapabilities({ env }).hostKind
  return hostKind === 'vscode-compatible' || hostKind === 'jetbrains'
}

function detectHostKind(env: NodeJS.ProcessEnv): TerminalHostKind {
  const termProgram = normalize(env.TERM_PROGRAM)
  const terminalEmulator = normalize(env.TERMINAL_EMULATOR)
  const bundleId = normalize(env.__CFBundleIdentifier)
  const appName = `${normalize(env.TERM_PROGRAM_VERSION)} ${bundleId}`

  if (isCi(env)) return 'ci'
  if (
    termProgram === 'vscode' ||
    termProgram === 'cursor' ||
    termProgram === 'windsurf' ||
    termProgram === 'trae' ||
    normalize(env.VSCODE_INJECTION) === '1' ||
    Boolean(env.VSCODE_PID?.trim()) ||
    Boolean(env.VSCODE_CWD?.trim()) ||
    Boolean(env.VSCODE_IPC_HOOK_CLI?.trim()) ||
    Boolean(env.CURSOR_TRACE_ID?.trim()) ||
    Boolean(env.WINDSURF_BIN?.trim()) ||
    Boolean(env.TRAE_IDE?.trim())
  ) {
    return 'vscode-compatible'
  }
  if (
    terminalEmulator.includes('jetbrains') ||
    terminalEmulator.includes('intellij') ||
    appName.includes('jetbrains') ||
    appName.includes('intellij') ||
    Boolean(env.JETBRAINS_IDE?.trim()) ||
    Boolean(env.JB_TERMINAL_SESSION?.trim())
  ) {
    return 'jetbrains'
  }
  if (termProgram === 'windows_terminal' || Boolean(env.WT_SESSION?.trim())) {
    return 'windows-terminal'
  }
  if (isGitBash(env)) return 'git-bash'
  if (termProgram === 'iterm.app' || termProgram === 'iterm2') return 'iterm2'
  if (termProgram === 'apple_terminal') return 'apple-terminal'
  if (termProgram === 'wezterm') return 'wezterm'
  if (termProgram === 'ghostty') return 'ghostty'
  if (termProgram === 'alacritty') return 'alacritty'
  if (Boolean(env.ConEmuANSI?.trim())) return 'conemu'
  return 'unknown'
}

function detectEmulatorKind(args: {
  env: NodeJS.ProcessEnv
  hostKind: TerminalHostKind
  termProgram: string
  terminalEmulator: string
  bundleId: string
}): TerminalEmulatorKind {
  if (args.hostKind === 'vscode-compatible') return 'xtermjs'
  if (args.hostKind === 'jetbrains') return 'jediterm'
  if (args.hostKind === 'windows-terminal') return 'windows-terminal'
  if (args.hostKind === 'git-bash') return 'mintty'
  if (args.hostKind === 'iterm2' || args.hostKind === 'apple-terminal') return 'native'
  if (normalize(args.env.MSYSTEM)) return 'mintty'
  if (args.terminalEmulator.includes('jediterm')) return 'jediterm'
  if (args.bundleId.includes('jetbrains')) return 'jediterm'
  return 'unknown'
}

function detectPlatformKind(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): TerminalPlatformKind {
  if (platform === 'win32') return 'windows-conpty'
  if (normalize(env.WSL_DISTRO_NAME) || normalize(env.WSL_INTEROP)) return 'wsl'
  if (platform === 'darwin' || platform === 'linux' || platform === 'freebsd') return 'unix'
  return 'unknown'
}

function createCapabilityReason(args: {
  env: NodeJS.ProcessEnv
  hostKind: TerminalHostKind
  emulatorKind: TerminalEmulatorKind
  platformKind: TerminalPlatformKind
  riskFlags: TerminalRiskFlag[]
}): string {
  const signals = [
    args.env.TERM_PROGRAM ? `TERM_PROGRAM=${args.env.TERM_PROGRAM}` : null,
    args.env.TERMINAL_EMULATOR ? `TERMINAL_EMULATOR=${args.env.TERMINAL_EMULATOR}` : null,
    args.env.WT_SESSION ? 'WT_SESSION' : null,
    args.env.VSCODE_PID ? 'VSCODE_PID' : null,
    args.env.CURSOR_TRACE_ID ? 'CURSOR_TRACE_ID' : null,
    args.env.WINDSURF_BIN ? 'WINDSURF_BIN' : null,
    args.env.TRAE_IDE ? 'TRAE_IDE' : null
  ].filter((signal): signal is string => signal !== null)
  const signalText = signals.length > 0 ? signals.join(', ') : 'no known terminal markers'
  const riskText = args.riskFlags.length > 0 ? `; risks=${args.riskFlags.join(',')}` : ''
  return `${args.hostKind}/${args.emulatorKind}/${args.platformKind} (${signalText})${riskText}`
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return [
    'CI',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'BUILDKITE',
    'CIRCLECI',
    'TF_BUILD',
    'TEAMCITY_VERSION',
    'JENKINS_URL'
  ].some((name) => isTruthyEnv(env[name]))
}

function isGitBash(env: NodeJS.ProcessEnv): boolean {
  const msystem = normalize(env.MSYSTEM)
  return msystem === 'mingw32' || msystem === 'mingw64' || msystem === 'ucrt64' || msystem === 'clang64'
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = normalize(value)
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}
