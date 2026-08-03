/**
 * Codex 兼容 `exec` / `exec resume` 参数解析与 stdin prompt 合并。
 *
 * 本模块保持轻量，不加载模型、会话、Ink 或 MCP，供 bootstrap 提前确定 cwd。
 */

/** exec 文本输出的颜色策略。 */
export type ExecColorMode = 'always' | 'never' | 'auto'

/** exec 工具可见性策略；不代表 OS 级 sandbox。 */
export type ExecSandboxMode = 'read-only' | 'workspace-write'

/** 参数解析后的命令动作。 */
export type ExecAction = 'run' | 'resume' | 'help' | 'resume-help' | 'version'

/** Codex 兼容 exec 参数。 */
export interface ExecArgs {
  action: ExecAction
  sessionId?: string
  resumeLast: boolean
  prompt?: string
  json: boolean
  cwd?: string
  model?: string
  images: string[]
  outputLastMessage?: string
  color: ExecColorMode
  ephemeral: boolean
  fullAuto: boolean
  skipGitRepoCheck: boolean
  sandbox: ExecSandboxMode
}

/** 可展示给调用方的 exec 参数错误，进程应以状态码 2 退出。 */
export class ExecArgsError extends Error {
  readonly exitCode = 2

  constructor(message: string) {
    super(message)
    this.name = 'ExecArgsError'
  }
}

const UNSUPPORTED_OPTIONS = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--add-dir',
  '--output-schema',
  '--oss',
  '--local-provider',
  '-p',
  '--profile',
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--all',
])

/**
 * 解析 `q-code exec` 后的 argv。
 *
 * @param argv - 不含 `exec` 本身的参数
 * @throws `ExecArgsError` 表示未知、缺失、冲突或明确不支持的参数
 */
export function parseExecArgs(argv: readonly string[]): ExecArgs {
  let command: 'run' | 'resume' = 'run'
  let afterDoubleDash = false
  let resumeLast = false
  let json = false
  let cwd: string | undefined
  let model: string | undefined
  const images: string[] = []
  let outputLastMessage: string | undefined
  let color: ExecColorMode = 'auto'
  let ephemeral = false
  let fullAuto = false
  let skipGitRepoCheck = false
  let sandbox: ExecSandboxMode = 'workspace-write'
  let help = false
  let version = false
  const positionals: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!

    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg === 'resume' && command === 'run' && positionals.length === 0) {
      command = 'resume'
      continue
    }

    if (!afterDoubleDash && arg !== '-' && arg.startsWith('-')) {
      const optionName = getOptionName(arg)
      if (UNSUPPORTED_OPTIONS.has(optionName)) {
        throw new ExecArgsError(`q-code exec 暂不支持参数 ${optionName}`)
      }

      if (arg === '--json') {
        json = true
        continue
      }
      if (arg === '--full-auto') {
        fullAuto = true
        continue
      }
      if (arg === '--skip-git-repo-check') {
        skipGitRepoCheck = true
        continue
      }
      if (arg === '--ephemeral') {
        ephemeral = true
        continue
      }
      if (arg === '--last') {
        if (command !== 'resume') throw new ExecArgsError('--last 只能用于 exec resume')
        resumeLast = true
        continue
      }
      if (arg === '-h' || arg === '--help') {
        help = true
        continue
      }
      if (arg === '-V' || arg === '--version') {
        version = true
        continue
      }

      const valueOption = readValueOption(argv, index, arg)
      if (valueOption) {
        index += valueOption.consumedNext ? 1 : 0
        switch (valueOption.name) {
          case '-C':
          case '--cd':
            cwd = requireValue(valueOption.name, valueOption.value)
            break
          case '-m':
          case '--model':
            model = requireValue(valueOption.name, valueOption.value)
            break
          case '-i':
          case '--image':
            images.push(requireValue(valueOption.name, valueOption.value))
            break
          case '-o':
          case '--output-last-message':
            outputLastMessage = requireValue(valueOption.name, valueOption.value)
            break
          case '--color':
            color = parseEnum(valueOption.name, valueOption.value, ['always', 'never', 'auto'])
            break
          case '-s':
          case '--sandbox':
            if (valueOption.value === 'danger-full-access') {
              throw new ExecArgsError('q-code exec 不支持 sandbox danger-full-access')
            }
            sandbox = parseEnum(valueOption.name, valueOption.value, ['read-only', 'workspace-write'])
            break
          default:
            throw new ExecArgsError(`未知参数: ${arg}`)
        }
        continue
      }

      throw new ExecArgsError(`未知参数: ${arg}`)
    }

    positionals.push(arg)
  }

  if (version) return createResult('version')
  if (help) return createResult(command === 'resume' ? 'resume-help' : 'help')

  let sessionId: string | undefined
  let prompt: string | undefined
  if (command === 'resume') {
    if (ephemeral) throw new ExecArgsError('--ephemeral 不能与 exec resume 同时使用')
    if (resumeLast) {
      if (positionals.length > 1) {
        throw new ExecArgsError('exec resume --last 只能接受一个 PROMPT')
      }
      prompt = positionals[0]
    } else {
      if (positionals.length > 2) {
        throw new ExecArgsError('exec resume 只能接受 SESSION_ID 和一个 PROMPT')
      }
      sessionId = positionals[0]
      prompt = positionals[1]
      if (!sessionId) throw new ExecArgsError('exec resume 需要 SESSION_ID 或 --last')
    }
  } else {
    if (positionals[0] === 'review') {
      throw new ExecArgsError('q-code exec 暂不支持 review 子命令')
    }
    if (positionals.length > 1) {
      throw new ExecArgsError('q-code exec 只能接受一个 PROMPT；包含空格时请使用引号')
    }
    prompt = positionals[0]
  }

  return createResult(command, sessionId, prompt)

  function createResult(
    action: ExecAction,
    resolvedSessionId?: string,
    resolvedPrompt?: string,
  ): ExecArgs {
    return {
      action,
      ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
      resumeLast,
      ...(resolvedPrompt !== undefined ? { prompt: resolvedPrompt } : {}),
      json,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      images,
      ...(outputLastMessage ? { outputLastMessage } : {}),
      color,
      ephemeral,
      fullAuto,
      skipGitRepoCheck,
      sandbox,
    }
  }
}

/**
 * 按 Codex 规则把 argv prompt 与管道 stdin 合并为最终 prompt。
 *
 * @param prompt - 位置参数 prompt；`-` 表示只读 stdin
 * @param stdin - 已读取的 stdin 文本
 * @param stdinPiped - stdin 是否来自管道
 */
export function composeExecPrompt(
  prompt: string | undefined,
  stdin: string,
  stdinPiped: boolean,
): string {
  const stdinText = stdin.trim()
  if (prompt === undefined || prompt === '-') {
    if (!stdinPiped || !stdinText) throw new ExecArgsError('PROMPT 为空；请传入参数或通过 stdin 提供')
    return stdinText
  }

  const promptText = prompt.trim()
  if (!promptText) throw new ExecArgsError('PROMPT 不能为空')
  if (!stdinPiped || !stdinText) return promptText
  return `${promptText}\n\n<stdin>\n${stdinText}\n</stdin>`
}

function getOptionName(arg: string): string {
  const equals = arg.indexOf('=')
  return equals >= 0 ? arg.slice(0, equals) : arg
}

function readValueOption(
  argv: readonly string[],
  index: number,
  arg: string,
): { name: string; value: string; consumedNext: boolean } | undefined {
  const name = getOptionName(arg)
  if (!['-C', '--cd', '-m', '--model', '-i', '--image', '-o', '--output-last-message', '--color', '-s', '--sandbox'].includes(name)) {
    return undefined
  }

  const equals = arg.indexOf('=')
  if (equals >= 0) {
    return { name, value: arg.slice(equals + 1), consumedNext: false }
  }
  return { name, value: argv[index + 1] ?? '', consumedNext: true }
}

function requireValue(name: string, value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('-')) throw new ExecArgsError(`${name} 需要一个值`)
  return trimmed
}

function parseEnum<const T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const normalized = requireValue(name, value)
  if (!allowed.includes(normalized as T)) {
    throw new ExecArgsError(`${name} 只支持: ${allowed.join(', ')}`)
  }
  return normalized as T
}
