/** ACP stdio 子命令参数解析；保持协议进程 stdout 只输出 JSON-RPC。 */

export interface AcpArgs {
  action: 'run' | 'help' | 'version'
  cwd?: string
}

export class AcpArgsError extends Error {
  readonly exitCode = 2
}

/** 解析 `q-code acp` 参数。 */
export function parseAcpArgs(argv: string[]): AcpArgs {
  let cwd: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { action: 'help' }
    if (arg === '--version' || arg === '-V') return { action: 'version' }
    if (arg === '--cd' || arg === '-C') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new AcpArgsError(`${arg} 需要一个工作目录`)
      cwd = value
      index += 1
      continue
    }
    if (arg.startsWith('--cd=')) {
      const value = arg.slice('--cd='.length).trim()
      if (!value) throw new AcpArgsError('--cd= 需要一个工作目录')
      cwd = value
      continue
    }
    throw new AcpArgsError(`q-code acp 暂不支持参数 ${arg}`)
  }

  return { action: 'run', ...(cwd ? { cwd } : {}) }
}

/** ACP 子命令帮助文案。 */
export function formatAcpHelp(version: string): string {
  return [
    `q-code ${version}`,
    '',
    'Run q-code as an Agent Client Protocol server',
    '',
    'Usage: q-code acp [OPTIONS]',
    '',
    'Options:',
    '  -C, --cd <DIR>    Set the workspace before accepting ACP requests',
    '  -h, --help        Show help and exit',
    '  -V, --version     Show version and exit',
    '',
    'The ACP server uses newline-delimited JSON-RPC on stdin/stdout.',
    'Diagnostics are written to stderr.'
  ].join('\n')
}
