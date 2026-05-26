import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRuntimeConfig, getRuntimeConfigPaths } from '../../src/config/runtime-config'

const ENV_KEYS = [
  'Q_CODE_HOME',
  'Q_CODE_DEBUG',
  'Q_CODE_GITLAB_URL',
  'Q_CODE_GITLAB_TOKEN',
  'Q_CODE_GITLAB_PROJECT_ID',
  'Q_CODE_GITLAB_KB_PREFIX',
  'Q_CODE_MENTION_ALLOW_ABS',
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
        'token_budget = 12345',
        '[q_code]',
        'debug = true',
        'mention_allow_abs = true',
        'shell_timeout_ms = 90000',
        '[mention]',
        'allow_abs = false',
        '[gitlab_kb]',
        'url = "https://gitlab.example.com/group/project"',
        'token = "glpat-test"',
        'project_id = "group/project"',
        'prefix = "team-kb"',
        '[shell]',
        'timeout_max_ms = 120000',
        'max_buffer = 2097152',
        'allow_abs_cwd = true',
        'kill_bg_on_exit = true'
      ].join('\n')
    )

    applyRuntimeConfig(cwd)

    expect(process.env.OPENAI_API_KEY).toBe('root-key')
    expect(process.env.OPENAI_MODEL).toBe('alias-model')
    expect(process.env.TOKEN_BUDGET).toBe('12345')
    expect(process.env.Q_CODE_DEBUG).toBe('true')
    expect(process.env.Q_CODE_MENTION_ALLOW_ABS).toBe('false')
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
