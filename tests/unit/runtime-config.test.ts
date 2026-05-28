import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRuntimeConfig, getRuntimeConfigPaths } from '../../src/config/runtime-config'

const ENV_KEYS = [
  'Q_CODE_HOME',
  'Q_CODE_DEBUG',
  'Q_CODE_LANGFUSE_ENABLED',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'Q_CODE_LANGFUSE_RECORD_IO',
  'Q_CODE_LANGFUSE_SAMPLE_RATE',
  'Q_CODE_LANGFUSE_ENVIRONMENT',
  'Q_CODE_LANGFUSE_RELEASE',
  'Q_CODE_LANGFUSE_FLUSH_AT',
  'Q_CODE_LANGFUSE_FLUSH_INTERVAL_SECONDS',
  'Q_CODE_LANGFUSE_TIMEOUT_SECONDS',
  'Q_CODE_MODEL_WAIT_HEARTBEAT_MS',
  'Q_CODE_MODEL_SLOW_REQUEST_WARN_MS',
  'Q_CODE_MODEL_STALLED_REQUEST_WARN_MS',
  'Q_CODE_MODEL_REQUEST_TIMEOUT_MS',
  'Q_CODE_TUI_CURSOR',
  'Q_CODE_MODEL_PROVIDER',
  'Q_CODE_THINKING_TYPE',
  'Q_CODE_REASONING_EFFORT',
  'Q_CODE_HISTORY_SCOPE',
  'Q_CODE_HISTORY_DISABLED',
  'Q_CODE_HISTORY_REDACT',
  'Q_CODE_HISTORY_SEARCH',
  'Q_CODE_HISTORY_MAX_LINES',
  'Q_CODE_HISTORY_MAX_BYTES',
  'Q_CODE_HISTORY_RUNTIME_LIMIT',
  'Q_CODE_HISTORY_MAX_LINE_BYTES',
  'Q_CODE_GITLAB_URL',
  'Q_CODE_GITLAB_TOKEN',
  'Q_CODE_GITLAB_PROJECT_ID',
  'Q_CODE_GITLAB_KB_PREFIX',
  'Q_CODE_MENTION_ALLOW_ABS',
  'Q_CODE_FILE_INDEX_IGNORE',
  'Q_CODE_SHELL_TIMEOUT_MS',
  'Q_CODE_SHELL_TIMEOUT_MAX_MS',
  'Q_CODE_SHELL_MAX_BUFFER',
  'Q_CODE_SHELL_ALLOW_ABS_CWD',
  'Q_CODE_SHELL_KILL_BG_ON_EXIT',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'SUMMARY_BASE_URL',
  'SUMMARY_API_KEY',
  'SUMMARY_MODEL',
  'CONTEXT_LIMIT_TOKENS',
  'MAX_STEPS',
  'TOKEN_BUDGET'
]

const previousEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) previousEnv[key] = process.env[key]

const tempDirs: string[] = []

afterEach(() => {
  for (const key of ENV_KEYS) restoreEnv(key, previousEnv[key])
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('runtime config', () => {
  it('loads global config.toml and defaults the model to gpt-5.4', () => {
    const { cwd, home } = setupConfigFixture()
    writeFileSync(
      join(home, 'config.toml'),
      ['[openai]', 'api_key = "sk-test"', 'base_url = "https://api.example.com/v1"'].join('\n')
    )

    applyRuntimeConfig(cwd)

    expect(process.env.OPENAI_API_KEY).toBe('sk-test')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.example.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('gpt-5.4')
    expect(process.env.SUMMARY_MODEL).toBe('gpt-5.4')
    expect(process.env.SUMMARY_API_KEY).toBe('sk-test')
  })

  it('does not synthesize a summary api key when the openai key is missing', () => {
    const { cwd } = setupConfigFixture()

    applyRuntimeConfig(cwd)

    expect(process.env.OPENAI_MODEL).toBe('gpt-5.4')
    expect(process.env.SUMMARY_MODEL).toBe('gpt-5.4')
    expect(process.env.SUMMARY_API_KEY).toBeUndefined()
  })

  it('lets project config override global config without overriding existing env vars', () => {
    const { cwd, home } = setupConfigFixture()
    writeFileSync(
      join(home, 'config.toml'),
      [
        '[openai]',
        'api_key = "global-key"',
        'base_url = "https://global.example.com/v1"',
        'model = "global-model"'
      ].join('\n')
    )
    mkdirSync(join(cwd, '.q-code'), { recursive: true })
    writeFileSync(
      join(cwd, '.q-code', 'config.toml'),
      ['[openai]', 'api_key = "project-key"', 'model = "project-model"'].join('\n')
    )
    process.env.OPENAI_MODEL = 'env-model'

    applyRuntimeConfig(cwd)

    expect(process.env.OPENAI_API_KEY).toBe('project-key')
    expect(process.env.OPENAI_BASE_URL).toBe('https://global.example.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('env-model')
  })

  it('lets config.toml override project .env values', () => {
    const { cwd, home } = setupConfigFixture()
    writeFileSync(
      join(cwd, '.env'),
      ['OPENAI_API_KEY=env-file-key', 'OPENAI_MODEL=env-file-model'].join('\n')
    )
    writeFileSync(
      join(home, 'config.toml'),
      ['[openai]', 'api_key = "toml-key"', 'model = "toml-model"'].join('\n')
    )

    applyRuntimeConfig(cwd)

    expect(process.env.OPENAI_API_KEY).toBe('toml-key')
    expect(process.env.OPENAI_MODEL).toBe('toml-model')
  })

  it('supports loading extra env file from config.toml', () => {
    const { cwd, home } = setupConfigFixture()
    writeFileSync(join(home, '.shared.env'), 'OPENAI_API_KEY=shared-key\nOPENAI_MODEL=shared-model\n')
    writeFileSync(join(home, 'config.toml'), '[env]\nfile = ".shared.env"\n')

    applyRuntimeConfig(cwd)

    expect(process.env.OPENAI_API_KEY).toBe('shared-key')
    expect(process.env.OPENAI_MODEL).toBe('shared-model')
  })

  it('lets toml keys override values loaded from env.file', () => {
    const { cwd, home } = setupConfigFixture()
    writeFileSync(join(home, '.shared.env'), 'OPENAI_API_KEY=shared-key\nOPENAI_MODEL=shared-model\n')
    writeFileSync(
      join(home, 'config.toml'),
      ['[env]', 'file = ".shared.env"', '[openai]', 'api_key = "toml-key"'].join('\n')
    )

    applyRuntimeConfig(cwd)

    expect(process.env.OPENAI_API_KEY).toBe('toml-key')
    expect(process.env.OPENAI_MODEL).toBe('shared-model')
  })

  it('keeps explicit environment variables above config.toml and .env', () => {
    const { cwd, home } = setupConfigFixture()
    writeFileSync(join(cwd, '.env'), 'OPENAI_API_KEY=env-file-key\n')
    writeFileSync(join(home, 'config.toml'), '[openai]\napi_key = "toml-key"\n')
    process.env.OPENAI_API_KEY = 'shell-key'

    applyRuntimeConfig(cwd)

    expect(process.env.OPENAI_API_KEY).toBe('shell-key')
  })

  it('loads uppercase root keys and runtime aliases', () => {
    const { cwd, home } = setupConfigFixture()
    writeFileSync(
      join(home, 'config.toml'),
      [
        'OPENAI_API_KEY = "root-key"',
        'openai_model = "alias-model"',
        '[runtime]',
        'context_limit_tokens = 12345',
        'model_wait_heartbeat_ms = 11',
        'model_slow_request_warn_ms = 31',
        'tui_cursor = "inline"',
        'thinking_type = "enabled"',
        'reasoning_effort = "high"',
        'token_budget = 999999',
        'max_steps = 3',
        '[q_code]',
        'debug = true',
        'theme = "light"',
        'history_scope = "project"',
        'history_disabled = false',
        'history_redact = true',
        'history_search = "fuzzy"',
        'history_max_lines = 100',
        'history_max_bytes = 2048',
        'history_runtime_limit = 50',
        'history_max_line_bytes = 4096',
        'model_stalled_request_warn_ms = 61',
        'model_request_timeout_ms = 120000',
        'thinking_type = "disabled"',
        'reasoning_effort = "minimal"',
        'mention_allow_abs = true',
        'shell_timeout_ms = 90000',
        '[langfuse]',
        'enabled = true',
        'public_key = "pk-test"',
        'secret_key = "sk-test"',
        'base_url = "http://langfuse.example.com"',
        'record_io = false',
        'sample_rate = 0.5',
        'environment = "dev"',
        'release = "test-release"',
        'flush_at = 3',
        'flush_interval_seconds = 2',
        'timeout_seconds = 4',
        '[mention]',
        'allow_abs = false',
        '[file_index]',
        'ignore = "build,out"',
        '[gitlab_kb]',
        'url = "https://gitlab.example.com/group/project"',
        'token = "glpat-test"',
        'project_id = "group/project"',
        'prefix = "team-kb"',
        '[shell]',
        'timeout_max_ms = 120000',
        'max_buffer = 2097152',
        'allow_abs_cwd = true',
        'kill_bg_on_exit = true',
        '[reasoning]',
        'provider = "deepseek-compatible"',
        'thinking_type = "adaptive"',
        'reasoning_effort = "xhigh"'
      ].join('\n')
    )

    applyRuntimeConfig(cwd)

    expect(process.env.OPENAI_API_KEY).toBe('root-key')
    expect(process.env.OPENAI_MODEL).toBe('alias-model')
    expect(process.env.CONTEXT_LIMIT_TOKENS).toBe('12345')
    expect(process.env.Q_CODE_MODEL_WAIT_HEARTBEAT_MS).toBe('11')
    expect(process.env.Q_CODE_MODEL_SLOW_REQUEST_WARN_MS).toBe('31')
    expect(process.env.Q_CODE_MODEL_STALLED_REQUEST_WARN_MS).toBe('61')
    expect(process.env.Q_CODE_MODEL_REQUEST_TIMEOUT_MS).toBe('120000')
    expect(process.env.Q_CODE_TUI_CURSOR).toBe('inline')
    expect(process.env.Q_CODE_MODEL_PROVIDER).toBe('deepseek-compatible')
    expect(process.env.Q_CODE_THINKING_TYPE).toBe('adaptive')
    expect(process.env.Q_CODE_REASONING_EFFORT).toBe('xhigh')
    expect(process.env.TOKEN_BUDGET).toBeUndefined()
    expect(process.env.MAX_STEPS).toBeUndefined()
    expect(process.env.Q_CODE_DEBUG).toBe('true')
    expect(process.env.Q_CODE_THEME).toBe('light')
    expect(process.env.Q_CODE_HISTORY_SCOPE).toBe('project')
    expect(process.env.Q_CODE_HISTORY_DISABLED).toBe('false')
    expect(process.env.Q_CODE_HISTORY_REDACT).toBe('true')
    expect(process.env.Q_CODE_HISTORY_SEARCH).toBe('fuzzy')
    expect(process.env.Q_CODE_HISTORY_MAX_LINES).toBe('100')
    expect(process.env.Q_CODE_HISTORY_MAX_BYTES).toBe('2048')
    expect(process.env.Q_CODE_HISTORY_RUNTIME_LIMIT).toBe('50')
    expect(process.env.Q_CODE_HISTORY_MAX_LINE_BYTES).toBe('4096')
    expect(process.env.Q_CODE_LANGFUSE_ENABLED).toBe('true')
    expect(process.env.LANGFUSE_PUBLIC_KEY).toBe('pk-test')
    expect(process.env.LANGFUSE_SECRET_KEY).toBe('sk-test')
    expect(process.env.LANGFUSE_BASE_URL).toBe('http://langfuse.example.com')
    expect(process.env.Q_CODE_LANGFUSE_RECORD_IO).toBe('false')
    expect(process.env.Q_CODE_LANGFUSE_SAMPLE_RATE).toBe('0.5')
    expect(process.env.Q_CODE_LANGFUSE_ENVIRONMENT).toBe('dev')
    expect(process.env.Q_CODE_LANGFUSE_RELEASE).toBe('test-release')
    expect(process.env.Q_CODE_LANGFUSE_FLUSH_AT).toBe('3')
    expect(process.env.Q_CODE_LANGFUSE_FLUSH_INTERVAL_SECONDS).toBe('2')
    expect(process.env.Q_CODE_LANGFUSE_TIMEOUT_SECONDS).toBe('4')
    expect(process.env.Q_CODE_MENTION_ALLOW_ABS).toBe('false')
    expect(process.env.Q_CODE_FILE_INDEX_IGNORE).toBe('build,out')
    expect(process.env.Q_CODE_SHELL_TIMEOUT_MS).toBe('90000')
    expect(process.env.Q_CODE_SHELL_TIMEOUT_MAX_MS).toBe('120000')
    expect(process.env.Q_CODE_SHELL_MAX_BUFFER).toBe('2097152')
    expect(process.env.Q_CODE_SHELL_ALLOW_ABS_CWD).toBe('true')
    expect(process.env.Q_CODE_SHELL_KILL_BG_ON_EXIT).toBe('true')
    expect(process.env.Q_CODE_GITLAB_URL).toBe('https://gitlab.example.com/group/project')
    expect(process.env.Q_CODE_GITLAB_TOKEN).toBe('glpat-test')
    expect(process.env.Q_CODE_GITLAB_PROJECT_ID).toBe('group/project')
    expect(process.env.Q_CODE_GITLAB_KB_PREFIX).toBe('team-kb')
  })

  it('reports the config file locations', () => {
    const { cwd, home } = setupConfigFixture()

    expect(getRuntimeConfigPaths(cwd)).toEqual({
      envPath: join(cwd, '.env'),
      userConfigPath: join(home, 'config.toml'),
      projectConfigPath: join(cwd, '.q-code', 'config.toml')
    })
  })

  it('loads history section aliases', () => {
    const { cwd, home } = setupConfigFixture()
    writeFileSync(
      join(home, 'config.toml'),
      [
        '[history]',
        'scope = "global"',
        'disabled = true',
        'redact = true',
        'search = "fuzzy"',
        'max_lines = 10',
        'max_bytes = 1024',
        'runtime_limit = 20',
        'max_line_bytes = 2048'
      ].join('\n')
    )

    applyRuntimeConfig(cwd)

    expect(process.env.Q_CODE_HISTORY_SCOPE).toBe('global')
    expect(process.env.Q_CODE_HISTORY_DISABLED).toBe('true')
    expect(process.env.Q_CODE_HISTORY_REDACT).toBe('true')
    expect(process.env.Q_CODE_HISTORY_SEARCH).toBe('fuzzy')
    expect(process.env.Q_CODE_HISTORY_MAX_LINES).toBe('10')
    expect(process.env.Q_CODE_HISTORY_MAX_BYTES).toBe('1024')
    expect(process.env.Q_CODE_HISTORY_RUNTIME_LIMIT).toBe('20')
    expect(process.env.Q_CODE_HISTORY_MAX_LINE_BYTES).toBe('2048')
  })
})

function setupConfigFixture(): { root: string; cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'q-code-runtime-config-'))
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(home, { recursive: true })
  tempDirs.push(root)

  for (const key of ENV_KEYS) delete process.env[key]
  process.env.Q_CODE_HOME = home

  return { root, cwd, home }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
