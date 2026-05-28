/**
 * 运行时配置加载：`.env`、用户/项目 `config.toml` 合并到 `process.env`。
 *
 * 优先级：已存在的进程环境变量不被覆盖；同文件内后写覆盖先写。
 * 加载顺序：项目 `.env` → 用户 toml（含 `[env].file`）→ 项目 toml。
 * TOML 键经 `ROOT_ALIASES` / `SECTION_ALIASES` 映射为标准 `ENV_NAME`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse as parseDotenv } from 'dotenv'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_MODEL = 'gpt-5.4'

const ROOT_ALIASES: Record<string, string> = {
  model: 'OPENAI_MODEL',
  openai_model: 'OPENAI_MODEL',
  base_url: 'OPENAI_BASE_URL',
  openai_base_url: 'OPENAI_BASE_URL',
  api_key: 'OPENAI_API_KEY',
  openai_api_key: 'OPENAI_API_KEY',
  model_provider: 'Q_CODE_MODEL_PROVIDER',
  summary_model: 'SUMMARY_MODEL',
  summary_base_url: 'SUMMARY_BASE_URL',
  summary_api_key: 'SUMMARY_API_KEY',
  thinking_type: 'Q_CODE_THINKING_TYPE',
  reasoning_effort: 'Q_CODE_REASONING_EFFORT'
}

const SECTION_ALIASES: Record<string, Record<string, string>> = {
  openai: {
    model: 'OPENAI_MODEL',
    base_url: 'OPENAI_BASE_URL',
    api_key: 'OPENAI_API_KEY',
    provider: 'Q_CODE_MODEL_PROVIDER'
  },
  summary: {
    model: 'SUMMARY_MODEL',
    base_url: 'SUMMARY_BASE_URL',
    api_key: 'SUMMARY_API_KEY'
  },
  runtime: {
    context_limit_tokens: 'CONTEXT_LIMIT_TOKENS',
    compact_trigger_ratio: 'COMPACT_TRIGGER_RATIO',
    warning_trigger_ratio: 'WARNING_TRIGGER_RATIO',
    blocking_trigger_ratio: 'BLOCKING_TRIGGER_RATIO',
    default_max_output_tokens: 'DEFAULT_MAX_OUTPUT_TOKENS',
    escalated_max_output_tokens: 'ESCALATED_MAX_OUTPUT_TOKENS',
    compact_max_output_tokens: 'COMPACT_MAX_OUTPUT_TOKENS',
    model_wait_heartbeat_ms: 'Q_CODE_MODEL_WAIT_HEARTBEAT_MS',
    model_slow_request_warn_ms: 'Q_CODE_MODEL_SLOW_REQUEST_WARN_MS',
    model_stalled_request_warn_ms: 'Q_CODE_MODEL_STALLED_REQUEST_WARN_MS',
    model_request_timeout_ms: 'Q_CODE_MODEL_REQUEST_TIMEOUT_MS',
    tui_cursor: 'Q_CODE_TUI_CURSOR',
    model_provider: 'Q_CODE_MODEL_PROVIDER',
    thinking_type: 'Q_CODE_THINKING_TYPE',
    reasoning_effort: 'Q_CODE_REASONING_EFFORT'
  },
  q_code: {
    session_dir: 'Q_CODE_SESSION_DIR',
    home: 'Q_CODE_HOME',
    project_root: 'Q_CODE_PROJECT_ROOT',
    teams: 'Q_CODE_TEAMS',
    debug: 'Q_CODE_DEBUG',
    audit_enabled: 'Q_CODE_AUDIT_ENABLED',
    audit_dir: 'Q_CODE_AUDIT_DIR',
    audit_retention_days: 'Q_CODE_AUDIT_RETENTION_DAYS',
    audit_max_file_bytes: 'Q_CODE_AUDIT_MAX_FILE_BYTES',
    audit_max_queue_size: 'Q_CODE_AUDIT_MAX_QUEUE_SIZE',
    audit_pii: 'Q_CODE_AUDIT_PII',
    crash_guard: 'Q_CODE_CRASH_GUARD',
    mention_allow_abs: 'Q_CODE_MENTION_ALLOW_ABS',
    file_index_ignore: 'Q_CODE_FILE_INDEX_IGNORE',
    shell_timeout_ms: 'Q_CODE_SHELL_TIMEOUT_MS',
    shell_timeout_max_ms: 'Q_CODE_SHELL_TIMEOUT_MAX_MS',
    shell_max_buffer: 'Q_CODE_SHELL_MAX_BUFFER',
    shell_allow_abs_cwd: 'Q_CODE_SHELL_ALLOW_ABS_CWD',
    shell_kill_bg_on_exit: 'Q_CODE_SHELL_KILL_BG_ON_EXIT',
    theme: 'Q_CODE_THEME',
    history_scope: 'Q_CODE_HISTORY_SCOPE',
    history_disabled: 'Q_CODE_HISTORY_DISABLED',
    history_redact: 'Q_CODE_HISTORY_REDACT',
    history_search: 'Q_CODE_HISTORY_SEARCH',
    history_max_lines: 'Q_CODE_HISTORY_MAX_LINES',
    history_max_bytes: 'Q_CODE_HISTORY_MAX_BYTES',
    history_runtime_limit: 'Q_CODE_HISTORY_RUNTIME_LIMIT',
    history_max_line_bytes: 'Q_CODE_HISTORY_MAX_LINE_BYTES',
    model_wait_heartbeat_ms: 'Q_CODE_MODEL_WAIT_HEARTBEAT_MS',
    model_slow_request_warn_ms: 'Q_CODE_MODEL_SLOW_REQUEST_WARN_MS',
    model_stalled_request_warn_ms: 'Q_CODE_MODEL_STALLED_REQUEST_WARN_MS',
    model_request_timeout_ms: 'Q_CODE_MODEL_REQUEST_TIMEOUT_MS',
    tui_cursor: 'Q_CODE_TUI_CURSOR',
    model_provider: 'Q_CODE_MODEL_PROVIDER',
    thinking_type: 'Q_CODE_THINKING_TYPE',
    reasoning_effort: 'Q_CODE_REASONING_EFFORT'
  },
  reasoning: {
    model_provider: 'Q_CODE_MODEL_PROVIDER',
    provider: 'Q_CODE_MODEL_PROVIDER',
    thinking_type: 'Q_CODE_THINKING_TYPE',
    reasoning_effort: 'Q_CODE_REASONING_EFFORT'
  },
  history: {
    scope: 'Q_CODE_HISTORY_SCOPE',
    disabled: 'Q_CODE_HISTORY_DISABLED',
    redact: 'Q_CODE_HISTORY_REDACT',
    search: 'Q_CODE_HISTORY_SEARCH',
    max_lines: 'Q_CODE_HISTORY_MAX_LINES',
    max_bytes: 'Q_CODE_HISTORY_MAX_BYTES',
    runtime_limit: 'Q_CODE_HISTORY_RUNTIME_LIMIT',
    max_line_bytes: 'Q_CODE_HISTORY_MAX_LINE_BYTES'
  },
  langfuse: {
    enabled: 'Q_CODE_LANGFUSE_ENABLED',
    public_key: 'LANGFUSE_PUBLIC_KEY',
    secret_key: 'LANGFUSE_SECRET_KEY',
    base_url: 'LANGFUSE_BASE_URL',
    record_io: 'Q_CODE_LANGFUSE_RECORD_IO',
    sample_rate: 'Q_CODE_LANGFUSE_SAMPLE_RATE',
    environment: 'Q_CODE_LANGFUSE_ENVIRONMENT',
    release: 'Q_CODE_LANGFUSE_RELEASE',
    flush_at: 'Q_CODE_LANGFUSE_FLUSH_AT',
    flush_interval_seconds: 'Q_CODE_LANGFUSE_FLUSH_INTERVAL_SECONDS',
    timeout_seconds: 'Q_CODE_LANGFUSE_TIMEOUT_SECONDS'
  },
  eval: {
    judge_base_url: 'Q_CODE_EVAL_JUDGE_BASE_URL',
    judge_api_key: 'Q_CODE_EVAL_JUDGE_API_KEY',
    judge_model: 'Q_CODE_EVAL_JUDGE_MODEL'
  },
  shell: {
    timeout_ms: 'Q_CODE_SHELL_TIMEOUT_MS',
    timeout_max_ms: 'Q_CODE_SHELL_TIMEOUT_MAX_MS',
    max_buffer: 'Q_CODE_SHELL_MAX_BUFFER',
    allow_abs_cwd: 'Q_CODE_SHELL_ALLOW_ABS_CWD',
    kill_bg_on_exit: 'Q_CODE_SHELL_KILL_BG_ON_EXIT'
  },
  mention: {
    allow_abs: 'Q_CODE_MENTION_ALLOW_ABS'
  },
  file_index: {
    ignore: 'Q_CODE_FILE_INDEX_IGNORE'
  },
  audit: {
    enabled: 'Q_CODE_AUDIT_ENABLED',
    dir: 'Q_CODE_AUDIT_DIR',
    retention_days: 'Q_CODE_AUDIT_RETENTION_DAYS',
    max_file_bytes: 'Q_CODE_AUDIT_MAX_FILE_BYTES',
    max_queue_size: 'Q_CODE_AUDIT_MAX_QUEUE_SIZE',
    pii: 'Q_CODE_AUDIT_PII'
  },
  infra: {
    enabled: 'Q_CODE_INFRA_ENABLED',
    base_url: 'Q_CODE_INFRA_BASE_URL',
    token: 'Q_CODE_INFRA_TOKEN',
    client_id: 'Q_CODE_INFRA_CLIENT_ID',
    cache_dir: 'Q_CODE_INFRA_CACHE_DIR',
    sync: 'Q_CODE_INFRA_SYNC',
    timeout_ms: 'Q_CODE_INFRA_TIMEOUT_MS',
    user_id: 'Q_CODE_INFRA_USER_ID',
    user_name: 'Q_CODE_INFRA_USER_NAME',
    user_groups: 'Q_CODE_INFRA_USER_GROUPS',
    upload_source: 'Q_CODE_INFRA_UPLOAD_SOURCE'
  },
  gitlab_kb: {
    enabled: 'Q_CODE_GITLAB_KB_ENABLED',
    url: 'Q_CODE_GITLAB_URL',
    token: 'Q_CODE_GITLAB_TOKEN',
    project_id: 'Q_CODE_GITLAB_PROJECT_ID',
    prefix: 'Q_CODE_GITLAB_KB_PREFIX',
    timeout_ms: 'Q_CODE_GITLAB_KB_TIMEOUT_MS'
  },
  search: {
    tavily_api_key: 'TAVILY_API_KEY',
    serper_api_key: 'SERPER_API_KEY'
  },
  mcp: {
    connect_timeout_ms: 'MCP_CONNECT_TIMEOUT_MS'
  }
}

/** TOML 各 section 的键值表（section 名为空字符串表示根级键）。 */
export type TomlConfigEntries = Record<string, Record<string, string | number | boolean>>

interface ParsedTomlConfig {
  entries: TomlConfigEntries
}

/**
 * 读取 `config.toml`；文件不存在时返回仅含空根 section 的结构。
 */
export function readTomlConfigFile(filePath: string): TomlConfigEntries {
  return readTomlConfig(filePath).entries
}

/**
 * 将配置条目序列化并写入 `config.toml`（自动创建父目录）。
 */
export function writeTomlConfigFile(filePath: string, entries: TomlConfigEntries): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, serializeTomlConfig(entries), 'utf-8')
}

/** `applyRuntimeConfig` 实际读取的配置文件路径。 */
export interface RuntimeConfigPaths {
  envPath: string
  userConfigPath: string
  projectConfigPath: string
}

/**
 * 解析默认配置路径（不读取文件）。
 *
 * 用户配置：`$Q_CODE_HOME/config.toml` 或 `~/.q-code/config.toml`；
 * 项目配置：`<cwd>/.q-code/config.toml`。
 */
export function getRuntimeConfigPaths(cwd: string = process.cwd()): RuntimeConfigPaths {
  const qCodeHome = process.env.Q_CODE_HOME?.trim()
    ? resolve(process.env.Q_CODE_HOME)
    : join(homedir(), '.q-code')
  return {
    envPath: join(resolve(cwd), '.env'),
    userConfigPath: join(qCodeHome, 'config.toml'),
    projectConfigPath: join(resolve(cwd), '.q-code', 'config.toml')
  }
}

/**
 * 加载并合并配置到 `process.env`，再应用 OpenAI/Summary 缺省值。
 *
 * 仅当某环境变量当前为空/仅空白时才写入，不覆盖 shell 或 CI 已导出的值。
 *
 * @param cwd - 项目工作目录，用于定位 `.env` 与项目 toml
 * @returns 本次使用的三个配置文件路径
 */
export function applyRuntimeConfig(cwd: string = process.cwd()): RuntimeConfigPaths {
  const paths = getRuntimeConfigPaths(cwd)
  const values = new Map<string, string>()

  mergeValues(values, readDotenvValues(paths.envPath))

  const userConfig = readTomlConfig(paths.userConfigPath)
  mergeValues(values, readExtraDotenvValues(userConfig, paths.userConfigPath, cwd))
  mergeValues(values, extractTomlEnvValues(userConfig))

  if (resolve(paths.projectConfigPath) !== resolve(paths.userConfigPath)) {
    const projectConfig = readTomlConfig(paths.projectConfigPath)
    mergeValues(values, readExtraDotenvValues(projectConfig, paths.projectConfigPath, cwd))
    mergeValues(values, extractTomlEnvValues(projectConfig))
  }

  // 已存在于 process.env 的键保持最高优先级（便于 CI/一次性 export 覆盖 toml）
  for (const [name, value] of values) {
    if (!hasEnvValue(name)) process.env[name] = value
  }

  applyDefaults()
  return paths
}

function applyDefaults(): void {
  if (!hasEnvValue('OPENAI_BASE_URL')) process.env.OPENAI_BASE_URL = DEFAULT_OPENAI_BASE_URL
  if (!hasEnvValue('OPENAI_MODEL')) process.env.OPENAI_MODEL = DEFAULT_OPENAI_MODEL
  if (!hasEnvValue('SUMMARY_BASE_URL')) process.env.SUMMARY_BASE_URL = process.env.OPENAI_BASE_URL
  if (!hasEnvValue('SUMMARY_API_KEY') && hasEnvValue('OPENAI_API_KEY')) {
    process.env.SUMMARY_API_KEY = process.env.OPENAI_API_KEY
  }
  if (!hasEnvValue('SUMMARY_MODEL')) process.env.SUMMARY_MODEL = process.env.OPENAI_MODEL
}

function readDotenvValues(filePath: string): Map<string, string> {
  if (!existsSync(filePath)) return new Map()
  const parsed = parseDotenv(readFileSync(filePath, 'utf-8'))
  const values = new Map<string, string>()
  for (const [name, value] of Object.entries(parsed)) {
    if (isEnvName(name) && value.trim()) values.set(name, value.trim())
  }
  return values
}

function readTomlConfig(filePath: string): ParsedTomlConfig {
  if (!existsSync(filePath)) return { entries: { '': {} } }
  return { entries: parseSimpleToml(readFileSync(filePath, 'utf-8'), filePath) }
}

function readExtraDotenvValues(
  config: ParsedTomlConfig,
  configPath: string,
  cwd: string
): Map<string, string> {
  const values = new Map<string, string>()
  const envSection = config.entries.env
  if (!envSection) return values

  const fileValue = envSection.file
  if (typeof fileValue !== 'string') return values

  const envPath = resolveConfigRelativePath(fileValue, configPath, cwd)
  mergeValues(values, readDotenvValues(envPath))
  return values
}

function extractTomlEnvValues(config: ParsedTomlConfig): Map<string, string> {
  const values = new Map<string, string>()

  for (const [section, entries] of Object.entries(config.entries)) {
    for (const [key, rawValue] of Object.entries(entries)) {
      if (section === 'env' && key === 'file') continue
      const value = String(rawValue).trim()
      if (!value) continue
      const envName = resolveEnvName(section, key)
      if (envName) values.set(envName, value)
    }
  }

  return values
}

function resolveConfigRelativePath(fileValue: string, configPath: string, cwd: string): string {
  const trimmed = fileValue.trim()
  if (!trimmed) return join(resolve(cwd), '.env')
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(trimmed)) return resolve(trimmed)
  return resolve(join(configPath, '..', trimmed))
}

function resolveEnvName(section: string, key: string): string | undefined {
  if (section === '') {
    if (isEnvName(key)) return key
    return ROOT_ALIASES[normalizeKey(key)]
  }

  const normalizedSection = normalizeKey(section)
  const normalizedKey = normalizeKey(key)
  if (SECTION_ALIASES[normalizedSection]?.[normalizedKey]) {
    return SECTION_ALIASES[normalizedSection][normalizedKey]
  }

  const prefix = normalizedSection.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const suffix = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const envName = `${prefix}_${suffix}`.replace(/_+/g, '_')
  return isEnvName(envName) ? envName : undefined
}

function serializeTomlConfig(entries: TomlConfigEntries): string {
  const lines: string[] = []
  const preferredSections = ['openai', 'summary', 'env', 'gitlab_kb']
  const sections = [
    ...preferredSections.filter(
      (section) => entries[section] && Object.keys(entries[section]).length > 0
    ),
    ...Object.keys(entries)
      .filter(
        (section) =>
          section !== '' &&
          !preferredSections.includes(section) &&
          Object.keys(entries[section] ?? {}).length > 0
      )
      .sort()
  ]

  for (const section of sections) {
    const sectionEntries = entries[section]
    if (!sectionEntries || Object.keys(sectionEntries).length === 0) continue

    lines.push(`[${section}]`)
    for (const [key, value] of Object.entries(sectionEntries)) {
      lines.push(`${key} = ${formatTomlScalar(value)}`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function formatTomlScalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

function parseSimpleToml(
  content: string,
  filePath: string
): TomlConfigEntries {
  const result: Record<string, Record<string, string | number | boolean>> = { '': {} }
  let section = ''

  content.split(/\r?\n/).forEach((line, index) => {
    const stripped = stripComment(line).trim()
    if (!stripped) return

    const sectionMatch = stripped.match(/^\[([A-Za-z0-9_.-]+)\]$/)
    if (sectionMatch) {
      section = sectionMatch[1]
      result[section] ??= {}
      return
    }

    const eqIndex = findEquals(stripped)
    if (eqIndex < 0) {
      throw new Error(`${filePath}:${index + 1}: TOML 解析失败，缺少 '='`)
    }

    const key = stripped.slice(0, eqIndex).trim()
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new Error(`${filePath}:${index + 1}: TOML 解析失败，非法 key '${key}'`)
    }
    const rawValue = stripped.slice(eqIndex + 1).trim()
    if (!rawValue) {
      throw new Error(`${filePath}:${index + 1}: TOML 解析失败，缺少 value`)
    }
    result[section][key] = parseTomlValue(rawValue, filePath, index + 1)
  })

  return result
}

function parseTomlValue(raw: string, filePath: string, line: number): string | number | boolean {
  if (raw.startsWith('"')) return parseBasicString(raw, filePath, line)
  if (raw.startsWith("'")) return parseLiteralString(raw, filePath, line)
  if (raw === 'true') return true
  if (raw === 'false') return false

  const numberValue = Number(raw.replace(/_/g, ''))
  if (Number.isFinite(numberValue) && /^[+-]?\d[\d_]*(\.\d[\d_]*)?$/.test(raw)) {
    return numberValue
  }

  throw new Error(`${filePath}:${line}: TOML 解析失败，value 需要是字符串、数字或布尔值`)
}

function parseBasicString(raw: string, filePath: string, line: number): string {
  if (!raw.endsWith('"')) {
    throw new Error(`${filePath}:${line}: TOML 解析失败，字符串缺少结束双引号`)
  }
  try {
    return JSON.parse(raw) as string
  } catch (error) {
    throw new Error(
      `${filePath}:${line}: TOML 解析失败，字符串转义无效: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function parseLiteralString(raw: string, filePath: string, line: number): string {
  if (!raw.endsWith("'")) {
    throw new Error(`${filePath}:${line}: TOML 解析失败，字符串缺少结束单引号`)
  }
  return raw.slice(1, -1)
}

function findEquals(line: string): number {
  let quote: '"' | "'" | undefined
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '=') return i
  }
  return -1
}

function stripComment(line: string): string {
  let quote: '"' | "'" | undefined
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#') return line.slice(0, i)
  }
  return line
}

function mergeValues(target: Map<string, string>, source: Map<string, string>): void {
  for (const [name, value] of source) target.set(name, value)
}

function hasEnvValue(name: string): boolean {
  return Boolean(process.env[name]?.trim())
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-.]/g, '_')
}

function isEnvName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name)
}
