/**
 * 跨平台 shell 启动参数解析：Windows 优先 PowerShell7，缺失时回退到 Windows PowerShell。
 */
import { existsSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'

/** 按平台解析出的 shell 启动参数。 */
export interface ShellInvocation {
  command: string
  args: string[]
  detached: boolean
  unavailableMessage: string
}

/** Shell 解析时可注入的环境和探测函数，便于测试 fallback 顺序。 */
export interface ShellResolutionOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  commandExists?: (command: string) => boolean
}

/** Shell 解析结果：成功时返回可执行 shell，失败时返回全部候选与统一提示。 */
export type ShellResolution =
  | { ok: true; shell: ShellInvocation; candidates: ShellInvocation[]; fallbacks: ShellInvocation[] }
  | { ok: false; candidates: ShellInvocation[]; unavailableMessage: string }

/** 判断子进程 spawn error 是否表示 shell 可执行文件不存在。 */
export function isShellNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/** 返回当前平台的 shell 候选列表，顺序即 fallback 顺序。 */
export function getShellInvocations(
  command: string,
  platform: NodeJS.Platform = process.platform
): ShellInvocation[] {
  if (platform === 'win32') {
    return [
      createWindowsPowerShellInvocation('pwsh', command),
      createWindowsPowerShellInvocation('powershell.exe', command)
    ]
  }

  return [
    {
      command: 'bash',
      args: ['-lc', command],
      detached: true,
      unavailableMessage:
        '[bash 不可用] 当前环境不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。'
    }
  ]
}

/** 返回当前平台的首选 shell，不做可执行文件探测；主要用于兼容旧调用和单元测试。 */
export function getShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform
): ShellInvocation {
  return getShellInvocations(command, platform)[0]
}

/** 按候选顺序选择第一个当前环境可执行的 shell。 */
export function resolveShellInvocation(
  command: string,
  options: ShellResolutionOptions = {}
): ShellResolution {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const candidates = getShellInvocations(command, platform)
  const exists =
    options.commandExists ?? ((candidate: string) => commandExistsOnPath(candidate, platform, env))
  const selectedIndex = candidates.findIndex((candidate) => exists(candidate.command))
  if (selectedIndex >= 0) {
    const fallbacks = candidates.slice(selectedIndex)
    return { ok: true, shell: fallbacks[0], candidates, fallbacks }
  }
  return { ok: false, candidates, unavailableMessage: formatShellUnavailableMessage(candidates) }
}

/** 将 shell 调用格式化为便于审计和错误诊断的命令行。 */
export function formatShellInvocation(shell: ShellInvocation): string {
  return [shell.command, ...shell.args].join(' ')
}

/** 汇总多个候选 shell 均不可用时的用户提示。 */
export function formatShellUnavailableMessage(candidates: readonly ShellInvocation[]): string {
  if (candidates.some((candidate) => candidate.command === 'powershell.exe')) {
    return '[PowerShell 不可用] 当前环境不支持 shell 命令。请安装 PowerShell7，或确认 pwsh / powershell.exe 在 PATH 中。'
  }
  return candidates[0]?.unavailableMessage ?? '[shell 不可用] 当前环境不支持 shell 命令。'
}

function createWindowsPowerShellInvocation(commandName: string, command: string): ShellInvocation {
  return {
    command: commandName,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command
    ],
    detached: false,
    unavailableMessage:
      '[PowerShell 不可用] 当前环境不支持 shell 命令。请安装 PowerShell7，或确认 pwsh / powershell.exe 在 PATH 中。'
  }
}

function commandExistsOnPath(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): boolean {
  if (command.includes('/') || command.includes('\\')) return existsSync(command)
  const pathValue = getEnvValue(env, 'PATH')
  if (!pathValue) return false
  const pathExts =
    platform === 'win32'
      ? (getEnvValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : ['']
  const hasExtension = extname(command) !== ''

  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const names = hasExtension ? [command] : pathExts.map((ext) => `${command}${ext}`)
    for (const name of names) {
      if (existsSync(join(dir, name))) return true
    }
  }
  return false
}

function getEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key]) return env[key]
  const lower = key.toLowerCase()
  const match = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower)
  return match ? env[match] : undefined
}
