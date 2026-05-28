import { spawnSync } from 'node:child_process'
import { resolveShellInvocation } from '../../src/runtime/shell-invocation'

export function canRunShellCommand(): boolean {
  try {
    const resolution = resolveShellInvocation(process.platform === 'win32' ? 'Write-Output ok' : 'echo ok')
    if (!resolution.ok) return false
    const shell = resolution.shell
    const result = spawnSync(shell.command, shell.args, {
      stdio: 'ignore'
    })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}
