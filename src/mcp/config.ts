/**
 * MCP 配置加载：合并用户/项目 `settings.json` 中的 mcpServers，并处理 legacy 回退。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {
  McpConfigLoadResult,
  McpHttpServerConfig,
  McpServerConfig,
  McpSseServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig
} from './types'

interface RawSettings {
  mcpServers?: unknown
}

interface JsonReadResult<T> {
  raw: T | null
  parseError?: string
}

/** 返回用户级与项目级 MCP 配置文件路径。 */
export function getMcpSettingsPaths(cwd: string = process.cwd()): {
  userSettingsPath: string
  projectSettingsPath: string
} {
  const qCodeHome = process.env.Q_CODE_HOME
    ? resolve(process.env.Q_CODE_HOME)
    : join(homedir(), '.q-code')
  return {
    userSettingsPath: join(qCodeHome, 'settings.json'),
    projectSettingsPath: join(resolve(cwd), '.q-code', 'settings.json')
  }
}

/** 加载并合并 MCP 服务端配置；项目级覆盖用户级同名 server。 */
export async function loadMcpConfigs(cwd: string = process.cwd()): Promise<McpConfigLoadResult> {
  const { userSettingsPath, projectSettingsPath } = getMcpSettingsPaths(cwd)
  const errors: string[] = []
  const [userFile, projectFile] = await Promise.all([
    readJsonFile<RawSettings>(userSettingsPath),
    readJsonFile<RawSettings>(projectSettingsPath)
  ])

  if (userFile.parseError) errors.push(userFile.parseError)
  if (projectFile.parseError) errors.push(projectFile.parseError)

  const userServers = extractScopedServers(userFile.raw, 'user', userSettingsPath, errors)
  const projectServers = extractScopedServers(projectFile.raw, 'project', projectSettingsPath, errors)
  const servers: Record<string, ScopedMcpServerConfig> = {
    ...userServers,
    ...projectServers
  }

  addLegacyGitHubFallback(servers)

  return {
    servers,
    errors,
    userSettingsPath,
    projectSettingsPath
  }
}

async function readJsonFile<T>(filePath: string): Promise<JsonReadResult<T>> {
  try {
    const content = await readFile(filePath, 'utf-8')
    return { raw: JSON.parse(content) as T }
  } catch (error) {
    if (isNotFoundError(error)) return { raw: null }
    if (error instanceof SyntaxError) {
      return { raw: null, parseError: `${filePath}: JSON 解析失败: ${error.message}` }
    }
    return {
      raw: null,
      parseError: `${filePath}: 读取失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

function extractScopedServers(
  raw: RawSettings | null,
  scope: 'user' | 'project',
  filePath: string,
  errors: string[]
): Record<string, ScopedMcpServerConfig> {
  if (!raw || raw.mcpServers === undefined) return {}
  if (!isRecord(raw.mcpServers)) {
    errors.push(`${filePath}: 'mcpServers' must be an object`)
    return {}
  }

  const servers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, value] of Object.entries(raw.mcpServers)) {
    const result = validateServerConfig(name, value, scope)
    if (!result.ok) {
      errors.push(result.error)
      continue
    }
    servers[name] = { ...result.value, scope }
  }
  return servers
}

function validateServerConfig(
  name: string,
  raw: unknown,
  scope: string
): { ok: true; value: McpServerConfig } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: `mcpServers.${name} (${scope}): config must be an object` }
  }

  const type = raw.type
  if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'sse') {
    return {
      ok: false,
      error: `mcpServers.${name} (${scope}): unsupported transport '${String(type)}'. Use stdio/http/sse.`
    }
  }

  if (type === 'http' || type === 'sse') {
    return validateRemoteConfig(name, raw, scope, type)
  }
  return validateStdioConfig(name, raw, scope)
}

function validateStdioConfig(
  name: string,
  raw: Record<string, unknown>,
  scope: string
): { ok: true; value: McpStdioServerConfig } | { ok: false; error: string } {
  if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
    return {
      ok: false,
      error: `mcpServers.${name} (${scope}): 'command' is required for stdio transport`
    }
  }
  if (raw.args !== undefined && !Array.isArray(raw.args)) {
    return { ok: false, error: `mcpServers.${name} (${scope}): 'args' must be an array of strings` }
  }
  if (Array.isArray(raw.args) && raw.args.some((item) => typeof item !== 'string')) {
    return { ok: false, error: `mcpServers.${name} (${scope}): 'args' must contain only strings` }
  }

  const env = validateStringMap(raw.env, `mcpServers.${name} (${scope}): 'env'`)
  if (!env.ok) return env

  return {
    ok: true,
    value: {
      type: 'stdio',
      command: raw.command.trim(),
      args: Array.isArray(raw.args) ? raw.args : [],
      ...(env.value ? { env: env.value } : {})
    }
  }
}

function validateRemoteConfig(
  name: string,
  raw: Record<string, unknown>,
  scope: string,
  type: 'http' | 'sse'
): { ok: true; value: McpHttpServerConfig | McpSseServerConfig } | { ok: false; error: string } {
  if (typeof raw.url !== 'string' || raw.url.trim().length === 0) {
    return { ok: false, error: `mcpServers.${name} (${scope}): '${type}' transport requires 'url'` }
  }
  try {
    new URL(raw.url)
  } catch {
    return { ok: false, error: `mcpServers.${name} (${scope}): invalid url '${raw.url}'` }
  }

  const headers = validateStringMap(raw.headers, `mcpServers.${name} (${scope}): 'headers'`)
  if (!headers.ok) return headers

  return {
    ok: true,
    value: {
      type,
      url: raw.url,
      ...(headers.value ? { headers: headers.value } : {})
    }
  }
}

function validateStringMap(
  value: unknown,
  label: string
): { ok: true; value?: Record<string, string> } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  if (!isRecord(value)) return { ok: false, error: `${label} must be a string map` }

  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return { ok: false, error: `${label}.${key} must be a string` }
    result[key] = item
  }
  return { ok: true, value: result }
}

function addLegacyGitHubFallback(servers: Record<string, ScopedMcpServerConfig>): void {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN
  if (!token || servers.github) return

  // 兼容旧版 q-code 的环境变量入口；新项目建议改用 settings.json 的 mcpServers。
  servers.github = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
    scope: 'legacy-env'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
