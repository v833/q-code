/**
 * GitLab Wiki 知识库环境变量解析与 URL 规范化。
 */

/** 从环境变量加载的 GitLab KB 运行时配置。 */
export interface GitLabKbConfig {
  enabled: boolean
  baseUrl?: string
  token?: string
  projectId?: string
  /** 从 `Q_CODE_GITLAB_URL` 路径段解析出的 `group/project` */
  projectPathFromUrl?: string
  /** Wiki 页 slug 前缀，用于过滤与发布命名空间 */
  pagePrefix: string
  timeoutMs: number
  /** 未启用时的可读原因（供 status 输出） */
  disabledReason?: string
}

/** `parseGitLabUrl` 的解析结果。 */
export interface ParsedGitLabUrl {
  baseUrl: string
  projectPath?: string
}

const DEFAULT_PAGE_PREFIX = 'q-code-kb'
const DEFAULT_TIMEOUT_MS = 10000

/**
 * 从环境变量加载 GitLab KB 配置。
 *
 * 显式 `Q_CODE_GITLAB_KB_ENABLED=false` 时强制禁用；否则在 URL 与 token 齐备时默认启用。
 *
 * @param env - 环境变量对象，默认 `process.env`（便于测试注入）
 */
export function loadGitLabKbConfig(
  env: Pick<NodeJS.ProcessEnv, string> = process.env
): GitLabKbConfig {
  const enabledRaw = clean(env.Q_CODE_GITLAB_KB_ENABLED)
  const urlRaw = clean(env.Q_CODE_GITLAB_URL)
  const token = clean(env.Q_CODE_GITLAB_TOKEN)
  const projectId = clean(env.Q_CODE_GITLAB_PROJECT_ID)
  const pagePrefix = normalizePrefix(clean(env.Q_CODE_GITLAB_KB_PREFIX) ?? DEFAULT_PAGE_PREFIX)
  const timeoutMs = getPositiveNumber(env.Q_CODE_GITLAB_KB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const parsedUrl = urlRaw ? parseGitLabUrl(urlRaw) : undefined

  if (isFalse(enabledRaw)) {
    return {
      enabled: false,
      ...(parsedUrl?.baseUrl ? { baseUrl: parsedUrl.baseUrl } : {}),
      ...(token ? { token } : {}),
      ...(projectId ? { projectId } : {}),
      ...(parsedUrl?.projectPath ? { projectPathFromUrl: parsedUrl.projectPath } : {}),
      pagePrefix,
      timeoutMs,
      disabledReason: 'Q_CODE_GITLAB_KB_ENABLED=false'
    }
  }

  const missing: string[] = []
  if (!parsedUrl?.baseUrl) missing.push('Q_CODE_GITLAB_URL')
  if (!token) missing.push('Q_CODE_GITLAB_TOKEN')
  const enabled = missing.length === 0 && (enabledRaw ? isTrue(enabledRaw) : true)

  return {
    enabled,
    ...(parsedUrl?.baseUrl ? { baseUrl: parsedUrl.baseUrl } : {}),
    ...(token ? { token } : {}),
    ...(projectId ? { projectId } : {}),
    ...(parsedUrl?.projectPath ? { projectPathFromUrl: parsedUrl.projectPath } : {}),
    pagePrefix,
    timeoutMs,
    ...(enabled
      ? {}
      : { disabledReason: missing.length > 0 ? `缺少 ${missing.join(', ')}` : '未启用' })
  }
}

/**
 * 将用户配置的 GitLab URL 规范为 API 所需的 `baseUrl` 与可选 `projectPath`。
 *
 * 支持项目页 URL、裸 API 根（含 `/api/v4` 时截断）及 `.git` 后缀。
 *
 * @param raw - 原始 URL 字符串
 */
export function parseGitLabUrl(raw: string): ParsedGitLabUrl | undefined {
  const trimmed = raw.trim().replace(/\.git$/, '')
  if (!trimmed) return undefined

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  const path = url.pathname.replace(/\/+$/, '')
  const apiIndex = path.indexOf('/api/v4')
  if (apiIndex >= 0) {
    return {
      baseUrl: `${url.origin}${path.slice(0, apiIndex)}` || url.origin
    }
  }

  const projectPath = path.replace(/^\/+/, '')
  return {
    baseUrl: url.origin,
    ...(projectPath ? { projectPath } : {})
  }
}

function normalizePrefix(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, '-')
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function isFalse(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes((value ?? '').toLowerCase())
}

function isTrue(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase())
}

function getPositiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
