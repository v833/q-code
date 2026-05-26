/**
 * 运行时 MCP 注册表：记录各 server 的连接状态与已适配的工具列表。
 */
import type { ToolDefinition } from '../tools/registry'
import type { McpServerConnection } from './types'

/** 单个 MCP 服务端在内存中的注册项。 */
export interface McpRegistryEntry {
  connection: McpServerConnection
  tools: ToolDefinition[]
}

const entries = new Map<string, McpRegistryEntry>()

/** 写入或覆盖指定 server 的注册项。 */
export function setMcpRegistryEntry(
  name: string,
  connection: McpServerConnection,
  tools: ToolDefinition[]
): void {
  entries.set(name, { connection, tools })
}

/** 删除指定 server 的注册项。 */
export function deleteMcpRegistryEntry(name: string): void {
  entries.delete(name)
}

/** 清空全部 MCP 注册项（bootstrap 前调用）。 */
export function clearMcpRegistry(): void {
  entries.clear()
}

/** 返回所有已注册 MCP 项的快照数组。 */
export function getMcpRegistry(): McpRegistryEntry[] {
  return Array.from(entries.values())
}

/** 按精确名称获取注册项。 */
export function getMcpRegistryEntry(name: string): McpRegistryEntry | undefined {
  return entries.get(name)
}

/** 按名称解析注册项，支持大小写不敏感匹配。 */
export function resolveMcpRegistryName(name: string): string | undefined {
  if (entries.has(name)) return name
  const lower = name.toLowerCase()
  return Array.from(entries.keys()).find((key) => key.toLowerCase() === lower)
}
