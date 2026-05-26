/**
 * 企业 AI 基建管理端 HTTP 客户端。
 *
 * 封装配置解析与 Skill 包下载，统一 Bearer 认证、超时与错误响应解析。
 */
import type {
  InfraConfig,
  InfraResolveConfigRequest,
  InfraResolveConfigResponse,
  InfraSkillPackage
} from './types'

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
    requestId?: string
  }
}

/** 调用 Infra 管理端 REST API 的客户端。 */
export class InfraApiClient {
  constructor(private readonly config: InfraConfig) {}

  /**
   * 根据客户端、用户与仓库上下文解析应下发的配置包。
   */
  async resolveConfig(request: InfraResolveConfigRequest): Promise<InfraResolveConfigResponse> {
    return this.post<InfraResolveConfigResponse>('/api/v1/client/config:resolve', request)
  }

  /**
   * 按相对或绝对 URL 下载 Skill 包 JSON。
   *
   * @param downloadUrl - 管理端返回的下载地址
   */
  async downloadSkill(downloadUrl: string): Promise<InfraSkillPackage> {
    const url = new URL(downloadUrl, this.config.baseUrl)
    return this.request<InfraSkillPackage>(url, { method: 'GET' })
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.config.baseUrl)
    return this.request<T>(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    })
  }

  private async request<T>(url: URL, init: RequestInit): Promise<T> {
    if (!this.config.baseUrl || !this.config.token) {
      throw new Error('Q_CODE_INFRA_BASE_URL and Q_CODE_INFRA_TOKEN are required')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.token}`,
          'X-Q-Code-Version': '1.0.0',
          'X-Q-Code-Client-Id': this.config.clientId,
          ...(init.headers ?? {})
        }
      })
      const text = await response.text()
      const parsed = text ? (JSON.parse(text) as ApiResponse<T>) : ({ success: true } as ApiResponse<T>)
      if (!response.ok || !parsed.success) {
        const message = parsed.error?.message ?? `${response.status} ${response.statusText}`
        throw new Error(message)
      }
      if (parsed.data === undefined) throw new Error('Infra API returned empty data')
      return parsed.data
    } finally {
      clearTimeout(timeout)
    }
  }
}
