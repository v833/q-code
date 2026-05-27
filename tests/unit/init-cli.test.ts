import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTomlConfigFile } from '../../src/config/runtime-config'
import {
  buildModelsUrl,
  fetchOpenAiModels,
  parseInitCliArgs,
  resolveInitConfigPath,
  runInitCli,
  type FetchOpenAiModelsResult,
  type InitPrompts
} from '../../src/runtime/init-cli'

const tempDirs: string[] = []
const previousQCodeHome = process.env.Q_CODE_HOME

afterEach(() => {
  if (previousQCodeHome === undefined) delete process.env.Q_CODE_HOME
  else process.env.Q_CODE_HOME = previousQCodeHome
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('init cli args', () => {
  it('defaults to user target', () => {
    expect(parseInitCliArgs([])).toEqual({ targets: ['user'], unknownArgs: [] })
  })

  it('supports local and user flags together', () => {
    expect(parseInitCliArgs(['--local', '-u'])).toEqual({
      targets: ['local', 'user'],
      unknownArgs: []
    })
  })

  it('collects unknown args', () => {
    expect(parseInitCliArgs(['--foo'])).toEqual({
      targets: ['user'],
      unknownArgs: ['--foo']
    })
  })
})

describe('init cli wizard', () => {
  it('writes openai and summary sections and optional env file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-init-'))
    tempDirs.push(cwd)
    const home = join(cwd, 'home')
    mkdirSync(home, { recursive: true })
    process.env.Q_CODE_HOME = home

    const configPath = resolveInitConfigPath('user', cwd)
    const answers = [
      '',
      'sk-main',
      '1',
      'n',
      '',
      'sk-summary',
      '2',
      'y',
      '.env.shared',
      ''
    ]
    let answerIndex = 0

    const prompts = createMockPrompts(() => answers[answerIndex++] ?? '')
    const fetchModels = async (): Promise<FetchOpenAiModelsResult> => ({
      ok: true,
      models: ['gpt-main', 'gpt-summary']
    })

    const code = await runInitCli({
      argv: ['--user'],
      cwd,
      prompts,
      fetchModels
    })

    expect(code).toBe(0)
    const config = readTomlConfigFile(configPath)
    expect(config.openai).toEqual({
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-main',
      model: 'gpt-main'
    })
    expect(config.summary).toEqual({
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-summary',
      model: 'gpt-summary'
    })
    expect(config.env).toEqual({ file: '.env.shared' })
    expect(config.gitlab_kb).toBeUndefined()

    const raw = readFileSync(configPath, 'utf-8')
    expect(raw).toContain('[openai]')
    expect(raw).toContain('[summary]')
    expect(raw).toContain('[env]')
  })

  it('copies main model config when summary should stay the same', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-init-same-'))
    tempDirs.push(cwd)
    const home = join(cwd, 'home')
    mkdirSync(home, { recursive: true })
    process.env.Q_CODE_HOME = home

    const configPath = resolveInitConfigPath('user', cwd)
    const answers = ['', 'sk-main', '1', '', 'n', '']
    let answerIndex = 0

    const code = await runInitCli({
      argv: [],
      cwd,
      prompts: createMockPrompts(() => answers[answerIndex++] ?? ''),
      fetchModels: async () => ({ ok: true, models: ['gpt-main'] })
    })

    expect(code).toBe(0)
    const config = readTomlConfigFile(configPath)
    expect(config.openai?.model).toBe('gpt-main')
    expect(config.summary).toEqual(config.openai)
    expect(config.env).toBeUndefined()
    expect(config.gitlab_kb).toBeUndefined()
  })

  it('removes env and gitlab_kb sections when user opts out on re-init', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-init-clear-'))
    tempDirs.push(cwd)
    const home = join(cwd, 'home')
    mkdirSync(home, { recursive: true })
    process.env.Q_CODE_HOME = home

    const configPath = resolveInitConfigPath('user', cwd)
    writeFileSync(
      configPath,
      [
        '[openai]',
        'api_key = "old-key"',
        'base_url = "https://api.openai.com/v1"',
        'model = "old-model"',
        '',
        '[env]',
        'file = ".env.old"',
        '',
        '[gitlab_kb]',
        'url = "https://gitlab.example.com/old"',
        'token = "glpat-old"',
        'prefix = "old-prefix"'
      ].join('\n')
    )

    const answers = ['', 'sk-main', '1', '', 'n', 'n']
    let answerIndex = 0

    const code = await runInitCli({
      argv: [],
      cwd,
      prompts: createMockPrompts(() => answers[answerIndex++] ?? ''),
      fetchModels: async () => ({ ok: true, models: ['gpt-main'] })
    })

    expect(code).toBe(0)
    const config = readTomlConfigFile(configPath)
    expect(config.env).toBeUndefined()
    expect(config.gitlab_kb).toBeUndefined()
    expect(config.openai?.api_key).toBe('sk-main')
  })

  it('writes gitlab_kb section when enabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-init-gitlab-'))
    tempDirs.push(cwd)
    const home = join(cwd, 'home')
    mkdirSync(home, { recursive: true })
    process.env.Q_CODE_HOME = home

    const configPath = resolveInitConfigPath('user', cwd)
    const answers = [
      '',
      'sk-main',
      '1',
      '',
      'n',
      'y',
      'https://gitlab.example.com/group/project',
      'glpat-test',
      ''
    ]
    let answerIndex = 0

    const code = await runInitCli({
      argv: [],
      cwd,
      prompts: createMockPrompts(() => answers[answerIndex++] ?? ''),
      fetchModels: async () => ({ ok: true, models: ['gpt-main'] })
    })

    expect(code).toBe(0)
    const config = readTomlConfigFile(configPath)
    expect(config.gitlab_kb).toEqual({
      url: 'https://gitlab.example.com/group/project',
      token: 'glpat-test',
      prefix: 'q-code-kb'
    })
  })

  it('returns 1 when model endpoint validation fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-init-fail-'))
    tempDirs.push(cwd)
    const home = join(cwd, 'home')
    mkdirSync(home, { recursive: true })
    process.env.Q_CODE_HOME = home

    const errors: string[] = []
    const code = await runInitCli({
      argv: [],
      cwd,
      prompts: createMockPrompts(() => 'sk-test', { errors }),
      fetchModels: async () => ({ ok: false, message: 'API Key 无效' })
    })

    expect(code).toBe(1)
    expect(errors).toContain('API Key 无效')
  })

  it('returns 2 for unknown arguments', async () => {
    const errors: string[] = []
    const code = await runInitCli({
      argv: ['--unknown'],
      cwd: process.cwd(),
      prompts: createMockPrompts(() => '', { errors })
    })

    expect(code).toBe(2)
    expect(errors.join('\n')).toContain('未知 init 参数')
  })
})

describe('fetchOpenAiModels', () => {
  it('builds models endpoint from base url', () => {
    expect(buildModelsUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/models')
    expect(buildModelsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models')
  })

  it('maps http status codes to error messages', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes('status-401')) {
        return new Response('unauthorized', { status: 401 })
      }
      if (url.includes('status-404')) {
        return new Response('not found', { status: 404 })
      }
      return new Response('bad gateway', { status: 502 })
    }

    try {
      expect(await fetchOpenAiModels('https://status-401.example.com/v1', 'sk-test')).toEqual({
        ok: false,
        message: 'API Key 无效'
      })
      expect(await fetchOpenAiModels('https://status-404.example.com/v1', 'sk-test')).toEqual({
        ok: false,
        message: 'Base Url 无效'
      })
      expect(await fetchOpenAiModels('https://status-502.example.com/v1', 'sk-test')).toEqual({
        ok: false,
        message: '配置错误'
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns sorted model ids from response payload', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })

    try {
      const result = await fetchOpenAiModels('https://api.example.com/v1', 'sk-test')
      expect(result).toEqual({ ok: true, models: ['a-model', 'z-model'] })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

function createMockPrompts(
  nextAnswer: () => string,
  options: { errors?: string[] } = {}
): InitPrompts {
  return {
    log: () => {},
    error: (text) => options.errors?.push(text),
    question: async (_prompt, defaultValue) => {
      const answer = nextAnswer()
      return answer.trim() || defaultValue || ''
    },
    confirm: async (_prompt, defaultYes) => {
      const answer = nextAnswer().trim().toLowerCase()
      if (!answer) return defaultYes
      return ['y', 'yes', '是', 'true', '1'].includes(answer)
    },
    chooseModel: async (models) => {
      const answer = nextAnswer().trim()
      const index = Number(answer)
      if (Number.isInteger(index) && index >= 1 && index <= models.length) {
        return models[index - 1]
      }
      return answer
    }
  }
}
