/**
 * `q-code update` 子命令：通过全局 `npm install -g @q-code-cli/q-code@latest` 升级 CLI。
 *
 * 在进入主交互循环前由早期 CLI 路由调用；支持 `--dry-run` 与可注入 runner（测试用）。
 */
import { spawn } from 'node:child_process'

const PACKAGE_NAME = '@q-code-cli/q-code'
const UPDATE_ARGS = ['install', '-g', `${PACKAGE_NAME}@latest`] as const

/** `UpdateRunner` 执行 npm 子进程后的结果。 */
export interface UpdateRunResult {
  exitCode: number
  error?: unknown
}

/** 可替换的更新命令执行器（单元测试注入 mock）。 */
export type UpdateRunner = (command: string, args: readonly string[]) => Promise<UpdateRunResult>

/** `runCliUpdate` 的输入选项。 */
export interface RunCliUpdateOptions {
  currentVersion: string
  argv: string[]
  platform?: NodeJS.Platform
  runner?: UpdateRunner
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

/**
 * 解析当前平台的 npm 全局安装命令（Windows 使用 `npm.cmd`）。
 *
 * @param platform - 默认 `process.platform`
 */
export function getUpdateCommand(platform: NodeJS.Platform = process.platform): {
  command: string
  args: readonly string[]
  display: string
} {
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    args: UPDATE_ARGS,
    display: `npm ${UPDATE_ARGS.join(' ')}`
  }
}

/**
 * 执行或模拟 CLI 自更新；向 stdout/stderr 输出进度与错误提示。
 *
 * @param options - 当前版本、argv（含 `--dry-run`）、可选 runner
 * @returns 进程退出码（未知参数为 2）
 */
export async function runCliUpdate(options: RunCliUpdateOptions): Promise<number> {
  const stdout = options.stdout ?? console.log
  const stderr = options.stderr ?? console.error
  const dryRun = options.argv.includes('--dry-run')
  const unknownArgs = options.argv.slice(1).filter((arg) => arg !== '--dry-run')
  const updateCommand = getUpdateCommand(options.platform)

  if (unknownArgs.length > 0) {
    stderr(`未知 update 参数: ${unknownArgs.join(' ')}`)
    stderr('可用选项: --dry-run')
    return 2
  }

  stdout(`q-code 当前版本: ${options.currentVersion}`)
  stdout(`更新命令: ${updateCommand.display}`)

  if (dryRun) {
    stdout('dry-run: 未执行更新。')
    return 0
  }

  stdout('正在更新 q-code 到 npm latest...')
  const runner = options.runner ?? defaultUpdateRunner
  const result = await runner(updateCommand.command, updateCommand.args)

  if (result.exitCode === 0) {
    stdout('更新完成。请运行 q-code --version 确认当前版本。')
    return 0
  }

  const error = result.error instanceof Error ? result.error.message : result.error
  stderr(`更新失败，退出码: ${result.exitCode}`)
  if (error) stderr(`错误: ${error}`)
  stderr(`可手动执行: ${updateCommand.display}`)
  return result.exitCode || 1
}

async function defaultUpdateRunner(command: string, args: readonly string[]): Promise<UpdateRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: 'inherit',
      windowsHide: true
    })

    child.on('error', (error) => {
      resolve({ exitCode: 1, error })
    })
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1 })
    })
  })
}
