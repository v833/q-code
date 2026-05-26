/**
 * Legacy 冒烟脚本：在临时目录启动内联 MCP server，验证 bootstrap、工具注册与重连。
 * 由 `pnpm test:mcp` 调用，非生产运行时路径。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  bootstrapMcp,
  closeMcpSubsystem,
  reconnectMcpServer,
  summarizeMcpRegistry
} from '../mcp/bootstrap'
import { buildMcpToolName } from '../mcp/names'
import { getMcpRegistryEntry } from '../mcp/registry'
import { ToolRegistry } from '../tools/registry'

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'q-code-mcp-'))
  const tmpHome = join(tmpRoot, 'home')
  const tmpProject = join(tmpRoot, 'project')
  const serverPath = join(tmpRoot, 'inline-mcp-server.mjs')

  try {
    await mkdir(join(tmpProject, '.q-code'), { recursive: true })
    await mkdir(tmpHome, { recursive: true })
    await writeFile(serverPath, buildInlineServerSource(), 'utf-8')
    await writeFile(
      join(tmpProject, '.q-code', 'settings.json'),
      JSON.stringify(
        {
          mcpServers: {
            'my.db': {
              command: process.execPath,
              args: [serverPath]
            }
          }
        },
        null,
        2
      ),
      'utf-8'
    )

    process.env.Q_CODE_HOME = tmpHome
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN

    const registry = new ToolRegistry()
    const result = await bootstrapMcp(tmpProject, registry)
    assert(
      result.config.errors.length === 0,
      `配置解析存在错误: ${result.config.errors.join('; ')}`
    )
    assert(result.toolCount === 1, `预期注册 1 个 MCP 工具，实际为 ${result.toolCount}`)

    const toolName = buildMcpToolName('my.db', 'echo.tool')
    const tool = registry.get(toolName)
    assert(tool !== undefined, `未找到工具 ${toolName}`)
    assert(tool?.isReadOnly === true, 'readOnlyHint 应映射为 isReadOnly=true')

    const discovered = registry.searchTools(toolName)
    assert(discovered.length === 1, 'tool_search 应能发现注册的 MCP 工具')
    const output = await discovered[0].execute({ message: 'hello mcp' }, { cwd: tmpProject })
    assert(output === 'hello mcp', `工具输出与预期不一致: ${String(output)}`)

    const entry = getMcpRegistryEntry('my.db')
    assert(entry?.connection.type === 'connected', '连接注册表应记录已连接状态')
    assert(summarizeMcpRegistry().includes('my.db: connected'), '连接概要应包含已连接的 server')

    const reconnected = await reconnectMcpServer('my.db', registry)
    assert(reconnected?.type === 'connected', '重连后连接状态应为 connected')

    console.log('MCP 冒烟测试通过')
  } finally {
    await closeMcpSubsystem()
    delete process.env.Q_CODE_HOME
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

function buildInlineServerSource(): string {
  const serverModule = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js')
  const stdioModule = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js')
  const typesModule = import.meta.resolve('@modelcontextprotocol/sdk/types.js')

  return `
import { Server } from ${JSON.stringify(serverModule)};
import { StdioServerTransport } from ${JSON.stringify(stdioModule)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesModule)};

const server = new Server(
  { name: "q-code-inline-test", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo.tool",
      description: "为 q-code MCP 冒烟测试回显一条消息。",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" }
        },
        required: ["message"]
      },
      annotations: { readOnlyHint: true }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: "text",
      text: String(request.params.arguments?.message ?? "")
    }
  ]
}));

await server.connect(new StdioServerTransport());
`
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
