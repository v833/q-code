/**
 * 企业 AI 基建（Infra）领域类型定义。
 *
 * 描述远程配置解析请求/响应、本地同步状态、配置包结构及落地摘要。
 */

/** 从环境变量解析出的 Infra 运行时配置。 */
export interface InfraConfig {
  /** 是否启用企业基建同步 */
  enabled: boolean
  /** 管理端 API 根地址 */
  baseUrl?: string
  /** Bearer 认证令牌 */
  token?: string
  /** 本机客户端唯一标识（持久化或环境变量指定） */
  clientId: string
  /** 本地缓存目录 */
  cacheDir: string
  /** 启动时是否自动同步 */
  syncOnStartup: boolean
  /** 是否随同步上报源码上下文（由环境变量控制） */
  uploadSource: boolean
  /** HTTP 请求超时（毫秒） */
  timeoutMs: number
}

/** 上报给管理端的用户身份信息。 */
export interface InfraUserInfo {
  id?: string
  name?: string
  /** 用户所属组/角色列表 */
  groups: string[]
}

/** 当前工作区 Git 仓库快照，用于配置匹配与审计。 */
export interface InfraRepoInfo {
  cwd: string
  remoteUrl?: string
  remoteHost?: string
  group?: string
  name?: string
  branch?: string
  commit?: string
  isDirty?: boolean
}

/** 匹配到的企业领域（域）元信息。 */
export interface InfraDomainInfo {
  id: string
  name: string
}

/** 配置包中引用的 Skill 条目（含下载地址）。 */
export interface InfraSkillRef {
  name: string
  version: string
  checksum?: string
  downloadUrl?: string
}

/** 从管理端下载的 Skill 包内容。 */
export interface InfraSkillPackage {
  name: string
  version: string
  checksum?: string
  files: Array<{
    path: string
    encoding?: string
    content: string
  }>
}

/** 管理端下发的企业配置包。 */
export interface InfraConfigPackage {
  packageId: string
  version: number
  checksum: string
  /** 写入 AGENTS.md 托管区块的规则正文 */
  agentRules?: string
  domainRules?: Record<string, unknown>
  mcpServers?: Record<string, unknown>
  skills?: InfraSkillRef[]
  writePolicy?: {
    agentRules?: 'managed_block'
    mcpServers?: 'merge'
    skills?: 'replace_by_version'
  }
  expiresAt?: string
}

/** 向管理端请求解析/下发配置包的请求体。 */
export interface InfraResolveConfigRequest {
  client: {
    id: string
    version: string
    platform: NodeJS.Platform
    shell?: string
  }
  user: InfraUserInfo
  repo: InfraRepoInfo
  /** 本地已应用包的版本指纹，用于增量判断 */
  currentState?: {
    packageId?: string
    version?: number
    checksum?: string
  }
}

/** 配置解析 API 的响应。 */
export interface InfraResolveConfigResponse {
  matched: boolean
  matchReason?: string
  domain?: InfraDomainInfo
  configPackage?: InfraConfigPackage
}

/** 项目级 Infra 同步状态（持久化到 `.q-code/infra-state.json`）。 */
export interface InfraState {
  clientId: string
  enabled: boolean
  status: 'never_synced' | 'applied' | 'stale' | 'disabled' | 'failed'
  lastSyncAt?: string
  lastSuccessAt?: string
  lastError?: string
  matchReason?: string
  domain?: InfraDomainInfo
  packageId?: string
  version?: number
  checksum?: string
  written?: InfraWriteSummary
  repo?: InfraRepoInfo
}

/** 配置包落地到工作区后的文件路径摘要。 */
export interface InfraWriteSummary {
  settingsPath?: string
  agentRulesPath?: string
  statePath: string
  mcpServersWritten: string[]
  skillsWritten: string[]
  agentRulesUpdated: boolean
}

/** 单次 `syncInfraConfig` 的执行结果。 */
export interface InfraSyncResult {
  status: InfraState['status']
  state: InfraState
  message: string
  /** 同步失败但沿用了上次成功落地的本地配置 */
  usedCache: boolean
  wroteConfig: boolean
}
