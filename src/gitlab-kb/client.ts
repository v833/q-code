/**
 * GitLab Wiki REST API 客户端。
 *
 * 使用 `PRIVATE-TOKEN` 认证，支持列表/读取/创建/更新及 upsert。
 */
import type { GitLabKbConfig } from './config'

/** GitLab Wiki 页面元数据与正文。 */
export interface GitLabWikiPage {
  title: string
  slug: string
  content?: string
  format?: string
  encoding?: string
}

/** 创建或更新 Wiki 页时的请求体字段。 */
export interface GitLabWikiWriteInput {
  title: string
  content: string
  slug?: string
  format?: 'markdown' | 'rdoc' | 'asciidoc' | 'org'
}

/** GitLab API 非 2xx 响应时抛出的错误，附带 HTTP 状态与原始响应体。 */
export class GitLabKbHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string
  ) {
    super(message)
    this.name = 'GitLabKbHttpError'
  }
}

/** 针对单个 GitLab 项目的 Wiki API 封装。 */
export class GitLabWikiClient {
  constructor(
    private readonly config: GitLabKbConfig,
    /** 已 URL 编码的 project id 或 `group%2Fproject` 路径 */
    private readonly projectId: string
  ) {}

  /**
   * 列出项目下全部 Wiki 页。
   *
   * @param options.withContent - 为 true 时请求体包含正文（搜索场景使用）
   */
  async listPages(options: { withContent?: boolean; signal?: AbortSignal } = {}): Promise<GitLabWikiPage[]> {
    return this.request<GitLabWikiPage[]>('/wikis', {
      method: 'GET',
      query: options.withContent ? { with_content: '1' } : undefined,
      signal: options.signal
    })
  }

  /** 按 slug 获取单页 Wiki。 */
  async getPage(slug: string, options: { signal?: AbortSignal } = {}): Promise<GitLabWikiPage> {
    return this.request<GitLabWikiPage>(`/wikis/${encodeURIComponent(slug)}`, {
      method: 'GET',
      signal: options.signal
    })
  }

  /** 创建新 Wiki 页。 */
  async createPage(
    input: GitLabWikiWriteInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<GitLabWikiPage> {
    return this.request<GitLabWikiPage>('/wikis', {
      method: 'POST',
      form: {
        title: input.title,
        content: input.content,
        format: input.format ?? 'markdown'
      },
      signal: options.signal
    })
  }

  /** 按 slug 更新已有 Wiki 页。 */
  async updatePage(
    slug: string,
    input: GitLabWikiWriteInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<GitLabWikiPage> {
    return this.request<GitLabWikiPage>(`/wikis/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      form: {
        title: input.title,
        content: input.content,
        format: input.format ?? 'markdown'
      },
      signal: options.signal
    })
  }

  /**
   * 存在则更新、404 则创建。
   *
   * @returns 最终页面与是否为新创建
   */
  async upsertPage(
    input: GitLabWikiWriteInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ page: GitLabWikiPage; created: boolean }> {
    const slug = input.slug ?? slugFromTitle(input.title)
    try {
      await this.getPage(slug, options)
      return {
        page: await this.updatePage(slug, input, options),
        created: false
      }
    } catch (error) {
      if (!(error instanceof GitLabKbHttpError) || error.status !== 404) throw error
      return {
        page: await this.createPage(input, options),
        created: true
      }
    }
  }

  private async request<T>(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE'
      query?: Record<string, string> | undefined
      form?: Record<string, string> | undefined
      signal?: AbortSignal
    }
  ): Promise<T> {
    if (!this.config.baseUrl || !this.config.token) {
      throw new Error('GitLab KB 未配置 baseUrl/token')
    }

    const url = new URL(
      `${this.config.baseUrl.replace(/\/+$/, '')}/api/v4/projects/${this.projectId}${path}`
    )
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const abortFromCaller = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) {
      abortFromCaller()
    } else {
      options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    }

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          Accept: 'application/json',
          'PRIVATE-TOKEN': this.config.token,
          ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        ...(options.form ? { body: new URLSearchParams(options.form) } : {}),
        signal: controller.signal
      })
      const text = await response.text()
      if (!response.ok) {
        throw new GitLabKbHttpError(formatGitLabError(response.status, text), response.status, text)
      }
      if (!text) return undefined as T
      return JSON.parse(text) as T
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

function formatGitLabError(status: number, text: string): string {
  const fallback = `GitLab Wiki API 请求失败: HTTP ${status}`
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown }
    const message = parsed.message ?? parsed.error
    if (typeof message === 'string') return `${fallback}: ${message}`
    if (message && typeof message === 'object') return `${fallback}: ${JSON.stringify(message)}`
  } catch {
    // 使用下方 fallback
  }
  return `${fallback}: ${text.slice(0, 500)}`
}

/**
 * 由标题生成 Wiki slug（空白转连字符、去掉 `.md` 与首尾斜杠）。
 */
export function slugFromTitle(title: string): string {
  return title
    .trim()
    .replace(/\.md$/i, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
}
