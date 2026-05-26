/**
 * MCP 客户端连接：stdio/http/sse 传输、连接缓存与进程退出清理。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  ConnectedMcpServer,
  McpHttpServerConfig,
  McpServerConnection,
  McpSseServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig
} from './types'

const DEFAULT_CONNECT_TIMEOUT_MS = 30000

interface TransportBundle {
  transport: Transport
  describe: string
  collectStderrTail: () => string
  preCleanup: () => Promise<void>
}

const connectionCache = new Map<string, Promise<McpServerConnection>>()
const activeConnections = new Map<string, ConnectedMcpServer>()
let cleanupRegistered = false

/** 连接 MCP 服务端（带缓存）；失败时返回 FailedMcpServer 形态。 */
export function connectToMcpServer(
  name: string,
  config: ScopedMcpServerConfig
): Promise<McpServerConnection> {
  const key = getCacheKey(name, config)
  const cached = connectionCache.get(key)
  if (cached) return cached

  const promise = doConnect(name, config)
  connectionCache.set(key, promise)
  void promise.then((connection) => {
    if (connection.type === 'connected') {
      activeConnections.set(name, connection)
    }
  })
  return promise
}

/** 清除指定 server 的连接缓存并执行 cleanup。 */
export async function clearMcpServerCache(name: string, config: ScopedMcpServerConfig): Promise<void> {
  connectionCache.delete(getCacheKey(name, config))
  const existing = activeConnections.get(name)
  if (!existing) return

  activeConnections.delete(name)
  await existing.cleanup()
}

/** 关闭所有活跃 MCP 连接并清空缓存。 */
export async function closeAllMcpConnections(): Promise<void> {
  const connections = Array.from(activeConnections.values())
  activeConnections.clear()
  connectionCache.clear()
  await Promise.allSettled(connections.map((connection) => connection.cleanup()))
}

/** 注册 SIGINT/SIGTERM/beforeExit 时自动关闭 MCP 连接（幂等）。 */
export function registerMcpProcessCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true

  const cleanup = () => {
    void closeAllMcpConnections()
  }

  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
  process.once('beforeExit', cleanup)
}

async function doConnect(
  name: string,
  config: ScopedMcpServerConfig
): Promise<McpServerConnection> {
  let bundle: TransportBundle
  try {
    bundle = createTransportBundle(name, config)
  } catch (error) {
    return {
      name,
      type: 'failed',
      config,
      error: error instanceof Error ? error.message : String(error)
    }
  }

  const client = new Client({ name: 'q-code', version: '1.0.0' }, { capabilities: {} })
  const timeoutMs = getConnectTimeoutMs()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      client.connect(bundle.transport),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`MCP server '${name}' connection timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      })
    ])
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const stderr = bundle.collectStderrTail().trim()
    const message = error instanceof Error ? error.message : String(error)
    const detail = stderr ? `${message} (stderr: ${stderr.slice(-500)})` : message
    await safeCleanup(bundle, client)
    return {
      name,
      type: 'failed',
      config,
      error: detail
    }
  }

  if (timeoutHandle) clearTimeout(timeoutHandle)
  const serverVersion = client.getServerVersion()
  const capabilities = client.getServerCapabilities()

  return {
    name,
    type: 'connected',
    config,
    client,
    capabilities,
    serverInfo: serverVersion
      ? {
          name: serverVersion.name ?? name,
          version: serverVersion.version ?? '?'
        }
      : undefined,
    cleanup: async () => {
      activeConnections.delete(name)
      await safeCleanup(bundle, client)
    }
  }
}

function createTransportBundle(name: string, config: ScopedMcpServerConfig): TransportBundle {
  if (config.type === 'http') return createHttpTransport(config)
  if (config.type === 'sse') return createSseTransport(config)
  return createStdioTransport(name, config)
}

function createStdioTransport(name: string, config: McpStdioServerConfig): TransportBundle {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: {
      ...getDefinedProcessEnv(),
      ...(config.env ?? {})
    },
    stderr: 'pipe'
  })

  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString()
    if (stderr.length > 65536) stderr = stderr.slice(-65536)
  })

  return {
    transport,
    describe: `stdio: ${config.command} ${config.args.join(' ')}`.trim(),
    collectStderrTail: () => stderr,
    preCleanup: async () => {
      await escalatedKill(name, transport.pid ?? undefined)
    }
  }
}

function createHttpTransport(config: McpHttpServerConfig): TransportBundle {
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: {
        'User-Agent': 'q-code/1.0.0',
        ...(config.headers ?? {})
      }
    }
  })

  return {
    transport,
    describe: `http: ${config.url}`,
    collectStderrTail: () => '',
    preCleanup: async () => {}
  }
}

function createSseTransport(config: McpSseServerConfig): TransportBundle {
  const headers = {
    'User-Agent': 'q-code/1.0.0',
    ...(config.headers ?? {})
  }
  const transport = new SSEClientTransport(new URL(config.url), {
    requestInit: { headers },
    eventSourceInit: {
      // SSE 的 GET 是长连，不能套普通请求超时；这里只补 headers，保持长连自然存活。
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            ...headers,
            Accept: 'text/event-stream'
          }
        })
    }
  })

  return {
    transport,
    describe: `sse: ${config.url}`,
    collectStderrTail: () => '',
    preCleanup: async () => {}
  }
}

async function safeCleanup(bundle: TransportBundle, client: Client): Promise<void> {
  try {
    await bundle.preCleanup()
  } catch {
    /* best-effort */
  }
  try {
    await client.close()
  } catch {
    try {
      await bundle.transport.close()
    } catch {
      /* best-effort */
    }
  }
}

async function escalatedKill(_name: string, pid: number | undefined): Promise<void> {
  if (!pid) return
  if (!isProcessAlive(pid)) return

  try {
    process.kill(pid, 'SIGINT')
  } catch {
    return
  }
  await sleep(100)
  if (!isProcessAlive(pid)) return

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  await sleep(400)
  if (!isProcessAlive(pid)) return

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getConnectTimeoutMs(): number {
  const value = Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? process.env.MCP_CONNECT_TIMEOUT ?? '')
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CONNECT_TIMEOUT_MS
}

function getCacheKey(name: string, config: ScopedMcpServerConfig): string {
  if (config.type === 'http' || config.type === 'sse') {
    return `${name}:${JSON.stringify({
      type: config.type,
      url: config.url,
      headers: config.headers
    })}`
  }
  return `${name}:${JSON.stringify({
    type: config.type,
    command: config.command,
    args: config.args,
    env: config.env
  })}`
}

function getDefinedProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}
