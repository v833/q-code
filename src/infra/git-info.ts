/**
 * 采集当前 Git 仓库信息，并解析 `remote.origin.url` 为 host/group/name。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { InfraRepoInfo } from './types'

const execFileAsync = promisify(execFile)

/**
 * 并行执行若干 `git` 子命令，组装 {@link InfraRepoInfo}。
 *
 * 非 Git 仓库或命令失败时，对应字段为 `undefined`（不抛错）。
 *
 * @param cwd - 项目工作目录
 */
export async function collectRepoInfo(cwd: string): Promise<InfraRepoInfo> {
  const [remoteUrl, branch, commit, status] = await Promise.all([
    git(cwd, ['config', '--get', 'remote.origin.url']),
    git(cwd, ['branch', '--show-current']),
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['status', '--porcelain'])
  ])
  const parsed = remoteUrl ? parseGitRemote(remoteUrl) : {}

  return {
    cwd,
    remoteUrl: remoteUrl || undefined,
    remoteHost: parsed.remoteHost,
    group: parsed.group,
    name: parsed.name,
    branch: branch || undefined,
    commit: commit || undefined,
    isDirty: status !== undefined ? status.length > 0 : undefined
  }
}

/**
 * 将 Git remote URL 解析为 `remoteHost`、`group`、`name`。
 *
 * 支持 HTTPS、SSH（`git@host:group/repo`）及松散 `host:path` 形式。
 *
 * @param remoteUrl - `git remote` 输出的 URL 字符串
 */
export function parseGitRemote(remoteUrl: string): Pick<InfraRepoInfo, 'remoteHost' | 'group' | 'name'> {
  const normalized = remoteUrl.trim().replace(/\.git$/, '')
  const https = parseAsUrl(normalized)
  if (https) return https

  const sshMatch = normalized.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/)
  if (sshMatch) return parsePathParts(sshMatch[1], sshMatch[2])

  const looseMatch = normalized.match(/^([^:/]+)[:/](.+)$/)
  if (looseMatch) return parsePathParts(looseMatch[1], looseMatch[2])

  return {}
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
    return stdout.trim()
  } catch {
    return undefined
  }
}

function parseAsUrl(value: string): Pick<InfraRepoInfo, 'remoteHost' | 'group' | 'name'> | null {
  try {
    const url = new URL(value)
    return parsePathParts(url.hostname, url.pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
}

function parsePathParts(remoteHost: string, repoPath: string): Pick<InfraRepoInfo, 'remoteHost' | 'group' | 'name'> {
  const parts = repoPath.split('/').filter(Boolean)
  const name = parts.pop()
  return {
    remoteHost,
    group: parts.length > 0 ? parts.join('/') : undefined,
    name
  }
}
