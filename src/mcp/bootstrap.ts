/**
 * MCP 子系统启动：加载配置、并行连接 server、将工具注册到 ToolRegistry。
 */
import { loadMcpConfigs } from './config'
import {
  clearMcpServerCache,
  closeAllMcpConnections,
  connectToMcpServer,
  registerMcpProcessCleanup
} from './client'
import { fetchToolsForConnection } from './fetch-tools'
import { buildMcpToolPrefix, normalizeNameForMcp } from './names'
import {
  clearMcpRegistry,
  deleteMcpRegistryEntry,
  getMcpRegistry,
  getMcpRegistryEntry,
  resolveMcpRegistryName,
  setMcpRegistryEntry
} from './registry'
import type { ToolRegistry } from '../tools/registry'
import type {
  McpConfigLoadResult,
  McpServerConnection,
  PendingMcpServer,
  ScopedMcpServerConfig
} from './types'

/** `bootstrapMcp` 的汇总结果。 */
export interface McpBootstrapResult {
  config: McpConfigLoadResult
  connections: McpServerConnection[]
  toolCount: number
}

/** 启动 MCP：清空旧注册、连接各 server 并将延迟工具写入 registry。 */
export async function bootstrapMcp(
  cwd: string,
  toolRegistry: ToolRegistry
): Promise<McpBootstrapResult> {
  const config = await loadMcpConfigs(cwd)
  registerMcpProcessCleanup()
  clearMcpRegistry()
  toolRegistry.unregisterByPrefix('mcp__')

  const skipped = seedPendingEntries(config.servers)
  const settled = await Promise.allSettled(
    Object.entries(config.servers).map(([name, serverConfig]) =>
      skipped.has(name)
        ? Promise.resolve({ connection: getMcpRegistryEntry(name)!.connection, toolCount: 0 })
        : connectAndRegister(name, serverConfig, toolRegistry)
    )
  )

  const connections: McpServerConnection[] = []
  let toolCount = 0
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      connections.push(result.value.connection)
      toolCount += result.value.toolCount
    }
  }

  return {
    config,
    connections,
    toolCount
  }
}

/** 重连单个 MCP server 并刷新其工具定义。 */
export async function reconnectMcpServer(
  requestedName: string,
  toolRegistry: ToolRegistry
): Promise<McpServerConnection | null> {
  const name = resolveMcpRegistryName(requestedName)
  if (!name) return null

  const entry = getMcpRegistryEntry(name)
  if (!entry) return null

  await clearMcpServerCache(name, entry.connection.config)
  deleteMcpRegistryEntry(name)
  toolRegistry.unregisterByPrefix(buildMcpToolPrefix(name))

  const pending: PendingMcpServer = {
    name,
    type: 'pending',
    config: entry.connection.config,
    startedAt: Date.now()
  }
  setMcpRegistryEntry(name, pending, [])

  const result = await connectAndRegister(name, entry.connection.config, toolRegistry)
  return result.connection
}

/** 关闭全部 MCP 连接并清空内存注册表。 */
export async function closeMcpSubsystem(): Promise<void> {
  await closeAllMcpConnections()
  clearMcpRegistry()
}

async function connectAndRegister(
  name: string,
  config: ScopedMcpServerConfig,
  toolRegistry: ToolRegistry
): Promise<{ connection: McpServerConnection; toolCount: number }> {
  const connection = await connectToMcpServer(name, config)
  if (connection.type !== 'connected') {
    setMcpRegistryEntry(name, connection, [])
    toolRegistry.unregisterByPrefix(buildMcpToolPrefix(name))
    return { connection, toolCount: 0 }
  }

  const tools = await fetchToolsForConnection(connection)
  toolRegistry.unregisterByPrefix(buildMcpToolPrefix(name))
  toolRegistry.register(...tools)
  setMcpRegistryEntry(name, connection, tools)
  return { connection, toolCount: tools.length }
}

function seedPendingEntries(servers: Record<string, ScopedMcpServerConfig>): Set<string> {
  const skipped = new Set<string>()
  const normalizedNames = new Map<string, string>()
  for (const [name, config] of Object.entries(servers)) {
    const normalized = normalizeNameForMcp(name)
    const conflicting = normalizedNames.get(normalized)
    if (conflicting) {
      setMcpRegistryEntry(
        name,
        {
          name,
          type: 'failed',
          config,
          error: `normalized name collides with '${conflicting}' as '${normalized}'`
        },
        []
      )
      skipped.add(name)
      continue
    }
    normalizedNames.set(normalized, name)
    setMcpRegistryEntry(
      name,
      {
        name,
        type: 'pending',
        config,
        startedAt: Date.now()
      },
      []
    )
  }
  return skipped
}

/** 生成 `/mcp` 等命令使用的 MCP 连接状态人类可读摘要。 */
export function summarizeMcpRegistry(): string {
  const entries = getMcpRegistry()
  if (entries.length === 0) return 'MCP Servers (0 configured)'

  const lines = [`MCP Servers (${entries.length} configured)`, '']
  for (const entry of entries) {
    const connection = entry.connection
    const transport = describeTransport(connection.config)
    if (connection.type === 'connected') {
      const serverInfo = connection.serverInfo
        ? ` server=${connection.serverInfo.name}@${connection.serverInfo.version}`
        : ''
      lines.push(
        `- ${connection.name}: connected (${transport}), tools=${entry.tools.length}${serverInfo}`
      )
    } else if (connection.type === 'pending') {
      lines.push(`- ${connection.name}: pending (${transport})`)
    } else if (connection.type === 'failed') {
      lines.push(`- ${connection.name}: failed (${transport}) - ${connection.error}`)
    } else {
      lines.push(`- ${connection.name}: disabled (${transport})`)
    }
  }
  lines.push('', 'Subcommands: /mcp tools <serverName> | /mcp reconnect <serverName>')
  return lines.join('\n')
}

/** 描述 MCP 传输类型与 scope（用于状态输出）。 */
export function describeTransport(config: ScopedMcpServerConfig): string {
  if (config.type === 'http' || config.type === 'sse') {
    return `${config.type} ${config.url} [${config.scope}]`
  }
  return `stdio ${config.command} ${config.args.join(' ')} [${config.scope}]`.trim()
}

/** 崩溃报告中使用的脱敏传输描述（不含完整 URL/命令细节）。 */
export function describeTransportForCrashReport(
  config: ScopedMcpServerConfig
): Record<string, unknown> {
  if (config.type === 'http' || config.type === 'sse') {
    return {
      transportType: config.type,
      scope: config.scope,
      urlOrigin: redactUrlOrigin(config.url)
    }
  }

  return {
    transportType: 'stdio',
    scope: config.scope,
    command: commandName(config.command),
    argCount: config.args.length
  }
}

function redactUrlOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return '[invalid-url]'
  }
}

function commandName(command: string): string {
  return command.split(/[\\/]/).filter(Boolean).at(-1) ?? '[configured]'
}
