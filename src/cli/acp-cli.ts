/** ACP stdio CLI 入口：解析工作目录并启动协议服务器，不加载 TUI。 */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AcpArgsError, formatAcpHelp, parseAcpArgs } from './acp-args'
import { formatCliVersion } from '../runtime/cli-info'
import type { StartupTrace } from '../runtime/startup-trace'

export interface RunAcpCliOptions {
  argv: string[]
  packageVersion: string
  startupTrace?: StartupTrace
  applyRuntimeConfig(): Promise<void>
}

/** 运行 ACP stdio 子命令并返回进程退出码。 */
export async function runAcpCli(options: RunAcpCliOptions): Promise<number> {
  let parsed: ReturnType<typeof parseAcpArgs> | undefined
  try {
    parsed = parseAcpArgs(options.argv)
    if (parsed.action === 'help') {
      process.stdout.write(`${formatAcpHelp(options.packageVersion)}\n`)
      return 0
    }
    if (parsed.action === 'version') {
      process.stdout.write(`${formatCliVersion(options.packageVersion)}\n`)
      return 0
    }

    const cwd = await resolveAcpCwd(parsed.cwd)
    process.chdir(cwd)
    await options.applyRuntimeConfig()

    const { runAcpServer } = await import('../acp/server')
    const abortController = new AbortController()
    const abort = (): void => abortController.abort(new Error('ACP 已被信号中断'))
    process.once('SIGINT', abort)
    process.once('SIGTERM', abort)
    try {
      await runAcpServer({
        cwd,
        packageVersion: options.packageVersion,
        signal: abortController.signal,
        onDiagnostic: (text) => process.stderr.write(`${text.trimEnd()}\n`)
      })
    } finally {
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
    }
    return abortController.signal.aborted ? 130 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    return error instanceof AcpArgsError ? error.exitCode : 1
  }
}

async function resolveAcpCwd(value: string | undefined): Promise<string> {
  const cwd = resolve(value ?? process.cwd())
  let info
  try {
    info = await stat(cwd)
  } catch {
    throw new AcpArgsError(`工作目录不存在: ${cwd}`)
  }
  if (!info.isDirectory()) throw new AcpArgsError(`工作目录不是文件夹: ${cwd}`)
  return cwd
}
