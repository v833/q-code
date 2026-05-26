/**
 * 将已连接 MCP server 的 tools/list 结果适配为 q-code ToolDefinition。
 */
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDefinition } from '../tools/registry'
import { buildMcpToolName } from './names'
import type { ConnectedMcpServer } from './types'

const MAX_MCP_DESCRIPTION_LENGTH = 2048

/** 拉取 MCP 工具列表并包装为延迟（shouldDefer）工具适配器。 */
export async function fetchToolsForConnection(
  connection: ConnectedMcpServer
): Promise<ToolDefinition[]> {
  if (!connection.capabilities?.tools) return []

  const result = await connection.client.listTools()
  return result.tools.map((tool) => buildToolAdapter(connection, tool))
}

function buildToolAdapter(connection: ConnectedMcpServer, tool: McpTool): ToolDefinition {
  const fullName = buildMcpToolName(connection.name, tool.name)
  const description = truncateDescription(tool.description)
  const isReadOnly = tool.annotations?.readOnlyHint === true

  return {
    name: fullName,
    description: `[MCP:${connection.name}] ${description}`,
    parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    isConcurrencySafe: true,
    isReadOnly,
    contextCost: 'high',
    resultShape: 'unknown',
    jitHint: '外部工具按需展开，先确认必要性',
    maxResultChars: 3000,
    shouldDefer: true,
    searchHint: `${connection.name} ${tool.name} ${description}`,
    execute: async (input: Record<string, unknown>) => {
      try {
        const result = await connection.client.callTool(
          {
            name: tool.name,
            arguments: input
          },
          CallToolResultSchema
        )
        const text = stringifyMcpResult(result as CallToolResult)
        return (result as CallToolResult).isError ? `MCP tool error:\n${text}` : text
      } catch (error) {
        return `MCP tool '${fullName}' failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}

function stringifyMcpResult(result: CallToolResult): string {
  const parts: string[] = []
  for (const block of result.content ?? []) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push(`[image: ${block.mimeType ?? '?'}, ${block.data.length} base64 chars]`)
    } else if (block.type === 'audio') {
      parts.push(`[audio: ${block.mimeType ?? '?'}, ${block.data.length} base64 chars]`)
    } else if (block.type === 'resource') {
      const resource = block.resource
      parts.push('text' in resource ? resource.text : `[resource: ${resource.uri}]`)
    } else if (block.type === 'resource_link') {
      parts.push(`[resource_link: ${block.name} ${block.uri}]`)
    } else {
      parts.push(`[${(block as { type?: string }).type ?? 'unknown'} block]`)
    }
  }

  if (result.structuredContent && Object.keys(result.structuredContent).length > 0) {
    parts.push(JSON.stringify(result.structuredContent, null, 2))
  }

  return parts.join('\n') || '(无返回内容)'
}

function truncateDescription(description: string | undefined): string {
  if (!description) return ''
  if (description.length <= MAX_MCP_DESCRIPTION_LENGTH) return description
  return `${description.slice(0, MAX_MCP_DESCRIPTION_LENGTH)}... [truncated]`
}
