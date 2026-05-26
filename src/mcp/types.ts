/**
 * MCP 配置与连接状态的类型定义（stdio / http / sse）。
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'

/** stdio 子进程方式的 MCP 服务端配置。 */
export interface McpStdioServerConfig {
  type: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
}

/** Streamable HTTP 方式的 MCP 服务端配置。 */
export interface McpHttpServerConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

/** SSE 方式的 MCP 服务端配置。 */
export interface McpSseServerConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

/** MCP 服务端配置的联合类型。 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig

/** 配置来源作用域。 */
export type McpConfigScope = 'user' | 'project' | 'legacy-env'

/** 带来源 scope 的 MCP 服务端配置。 */
export type ScopedMcpServerConfig = McpServerConfig & {
  scope: McpConfigScope
}

/** 已成功连接的 MCP 服务端。 */
export interface ConnectedMcpServer {
  name: string
  type: 'connected'
  config: ScopedMcpServerConfig
  capabilities?: ServerCapabilities
  serverInfo?: { name: string; version: string }
  client: Client
  cleanup: () => Promise<void>
}

/** 正在连接中的 MCP 服务端。 */
export interface PendingMcpServer {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  startedAt: number
}

/** 连接失败的 MCP 服务端。 */
export interface FailedMcpServer {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error: string
}

/** 被禁用或未尝试连接的 MCP 服务端。 */
export interface DisabledMcpServer {
  name: string
  type: 'disabled'
  config: ScopedMcpServerConfig
}

/** MCP 连接状态的判别联合。 */
export type McpServerConnection =
  | ConnectedMcpServer
  | PendingMcpServer
  | FailedMcpServer
  | DisabledMcpServer

/** `loadMcpConfigs` 的返回结构。 */
export interface McpConfigLoadResult {
  servers: Record<string, ScopedMcpServerConfig>
  errors: string[]
  userSettingsPath: string
  projectSettingsPath: string
}
