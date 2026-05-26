/**
 * 解析 GitLab KB 目标项目：显式 ID、URL 路径或当前 Git origin 推断。
 */
import { collectRepoInfo } from '../infra/git-info'
import type { InfraRepoInfo } from '../infra/types'
import { loadGitLabKbConfig, type GitLabKbConfig } from './config'

/** 已解析的 GitLab 项目上下文（含编码后的 API project id）。 */
export interface GitLabKbTarget {
  config: GitLabKbConfig
  projectId: string
  projectPath?: string
  repo?: InfraRepoInfo
}

/**
 * 根据配置与当前工作区确定 Wiki API 使用的 project id。
 *
 * 优先级：`Q_CODE_GITLAB_PROJECT_ID` → URL 中的 project 路径 → git remote 推断。
 *
 * @param cwd - 项目工作目录
 * @param config - 可选，默认 `loadGitLabKbConfig()`
 * @throws 未启用、缺少凭证或无法推断 project 时
 */
export async function resolveGitLabKbTarget(
  cwd: string,
  config: GitLabKbConfig = loadGitLabKbConfig()
): Promise<GitLabKbTarget> {
  if (!config.enabled) {
    throw new Error(config.disabledReason ?? 'GitLab KB 未启用')
  }
  if (!config.baseUrl || !config.token) {
    throw new Error('GitLab KB 需要配置 Q_CODE_GITLAB_URL 和 Q_CODE_GITLAB_TOKEN')
  }

  if (config.projectId) {
    return {
      config,
      projectId: encodeProjectId(config.projectId),
      projectPath: config.projectId
    }
  }

  if (config.projectPathFromUrl) {
    return {
      config,
      projectId: encodeProjectId(config.projectPathFromUrl),
      projectPath: config.projectPathFromUrl
    }
  }

  const repo = await collectRepoInfo(cwd)
  const projectPath = inferProjectPathFromRepo(config, repo)
  if (!projectPath) {
    throw new Error(
      '无法推断 GitLab project。请配置 Q_CODE_GITLAB_PROJECT_ID，或把 Q_CODE_GITLAB_URL 设为项目地址。'
    )
  }

  return {
    config,
    projectId: encodeProjectId(projectPath),
    projectPath,
    repo
  }
}

/**
 * 将 project id 或 `group/project` 路径编码为 GitLab API 路径段。
 */
export function encodeProjectId(projectIdOrPath: string): string {
  return encodeURIComponent(projectIdOrPath.trim().replace(/\.git$/, '').replace(/^\/+|\/+$/g, ''))
}

/**
 * 当 git remote 主机与 `baseUrl` 一致时，从 group/name 推断 `group/project`。
 */
export function inferProjectPathFromRepo(
  config: GitLabKbConfig,
  repo: Pick<InfraRepoInfo, 'remoteHost' | 'group' | 'name'>
): string | undefined {
  if (!repo.group || !repo.name) return undefined
  if (!config.baseUrl) return `${repo.group}/${repo.name}`

  try {
    const gitlabHost = new URL(config.baseUrl).hostname.toLowerCase()
    if (repo.remoteHost && repo.remoteHost.toLowerCase() !== gitlabHost) return undefined
  } catch {
    return undefined
  }

  return `${repo.group}/${repo.name}`
}
