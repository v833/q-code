/**
 * MCP 工具命名：将 server/tool 名规范为 `mcp__<server>__<tool>` 形式。
 */

/** 将名称规范为 MCP 工具名允许的字符集（最长 48）。 */
export function normalizeNameForMcp(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
  return normalized || 'server'
}

/** 构造注册到 ToolRegistry 的完整 MCP 工具名。 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMcp(serverName)}__${normalizeNameForMcp(toolName)}`
}

/** 返回某 MCP 服务端下所有工具名的前缀，用于批量 unregister。 */
export function buildMcpToolPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMcp(serverName)}__`
}

/** 从完整工具名解析 server 与 tool 段；非 MCP 名返回 null。 */
export function parseMcpToolName(fullName: string): { serverName: string; toolName: string } | null {
  const parts = fullName.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp' || !parts[1]) return null
  return {
    serverName: parts[1],
    toolName: parts.slice(2).join('__')
  }
}
