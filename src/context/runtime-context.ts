/**
 * 运行环境上下文：采集 cwd、日期、OS 与可选 Git 信息，供 system prompt 注入。
 */
import { execFile } from 'node:child_process'
import * as os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 单次 prompt 组装所需的运行环境快照。 */
export interface RuntimeEnvironmentContext {
  cwd: string
  date: string
  os: string
  gitBranch?: string
  gitStatus?: string
  gitRecentCommit?: string
}

/**
 * 采集当前运行环境上下文；Git 命令失败时静默省略 Git 字段。
 * @param cwd Git 与路径基准目录，默认 `process.cwd()`
 */
export async function getRuntimeEnvironmentContext(
  cwd = process.cwd()
): Promise<RuntimeEnvironmentContext> {
  return {
    cwd,
    date: new Date().toISOString(),
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    ...(await getGitContext(cwd))
  }
}

/**
 * 将运行环境上下文格式化为中文多行文本。
 * @param context `getRuntimeEnvironmentContext` 的返回值
 */
export function formatRuntimeEnvironmentContext(context: RuntimeEnvironmentContext): string {
  const lines = [
    '运行环境：',
    `- 当前工作目录: ${context.cwd}`,
    `- 当前日期: ${context.date}`,
    `- 操作系统: ${context.os}`
  ]

  if (context.gitBranch) lines.push(`- Git 分支: ${context.gitBranch}`)
  if (context.gitStatus) lines.push(`- Git 状态:\n${context.gitStatus}`)
  if (context.gitRecentCommit) lines.push(`- 最近提交: ${context.gitRecentCommit}`)

  return lines.join('\n')
}

async function getGitContext(
  cwd: string
): Promise<Pick<RuntimeEnvironmentContext, 'gitBranch' | 'gitStatus' | 'gitRecentCommit'>> {
  try {
    const [branchResult, statusResult, logResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, maxBuffer: 32 * 1024 }),
      execFileAsync('git', ['status', '--short'], { cwd, maxBuffer: 128 * 1024 }),
      execFileAsync('git', ['log', '-1', '--pretty=format:%h %s'], { cwd, maxBuffer: 32 * 1024 })
    ])

    return {
      gitBranch: branchResult.stdout.trim(),
      gitStatus: statusResult.stdout.trim() || 'clean',
      gitRecentCommit: logResult.stdout.trim() || undefined
    }
  } catch {
    // 运行环境信息为辅助内容，Git 不可用时不阻塞 prompt 组装
    return {}
  }
}
