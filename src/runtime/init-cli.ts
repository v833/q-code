/**
 * `q-code init` 子命令：交互式生成用户或项目 `config.toml`。
 *
 * 在进入主交互循环前由早期 CLI 路由调用；支持 `--local` / `--user` 目标与可注入 IO（测试用）。
 */
import { createInterface, type Interface } from 'node:readline'
import {
  getRuntimeConfigPaths,
  readTomlConfigFile,
  writeTomlConfigFile,
  type TomlConfigEntries
} from '../config/runtime-config.js'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** init 写入的配置目标。 */
export type InitConfigTarget = 'user' | 'local'

/** 可注入的交互输入（单元测试用）。 */
export interface InitPrompts {
  log: (text: string) => void
  error: (text: string) => void
  question: (prompt: string, defaultValue?: string) => Promise<string>
  confirm: (prompt: string, defaultYes: boolean) => Promise<boolean>
  chooseModel: (models: string[], sectionLabel: string) => Promise<string>
}

/** `fetchOpenAiModels` 的成功结果。 */
export interface OpenAiModelsResult {
  ok: true
  models: string[]
}

/** `fetchOpenAiModels` 的失败结果。 */
export interface OpenAiModelsError {
  ok: false
  message: string
}

export type FetchOpenAiModelsResult = OpenAiModelsResult | OpenAiModelsError

/** `runInitCli` 的输入选项。 */
export interface RunInitCliOptions {
  argv: string[]
  cwd?: string
  fetchModels?: (baseUrl: string, apiKey: string) => Promise<FetchOpenAiModelsResult>
  prompts?: InitPrompts
}

/** `parseInitCliArgs` 的解析结果。 */
export interface ParsedInitCliArgs {
  targets: InitConfigTarget[]
  unknownArgs: string[]
}

interface OpenAiSectionConfig {
  base_url: string
  api_key: string
  model: string
}

interface GitLabKbSectionConfig {
  url: string
  token: string
  prefix: string
}

/**
 * 解析 `init` 子命令参数。
 *
 * 默认写入用户目录；`--local` / `-l` 与 `--user` / `-u` 可同时指定以初始化两份配置。
 */
export function parseInitCliArgs(argv: string[]): ParsedInitCliArgs {
  const unknownArgs: string[] = []
  let useLocal = false
  let useUser = false

  for (const arg of argv) {
    if (arg === '--local' || arg === '-l') {
      useLocal = true
      continue
    }
    if (arg === '--user' || arg === '-u') {
      useUser = true
      continue
    }
    unknownArgs.push(arg)
  }

  const targets: InitConfigTarget[] = []
  if (useLocal) targets.push('local')
  if (useUser || targets.length === 0) targets.push('user')

  return { targets, unknownArgs }
}

/**
 * 根据 base_url 与 api_key 请求 `/models` 并返回可用模型 id 列表。
 */
export async function fetchOpenAiModels(
  baseUrl: string,
  apiKey: string
): Promise<FetchOpenAiModelsResult> {
  const modelsUrl = buildModelsUrl(baseUrl)

  try {
    const response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })

    if (response.status === 401) {
      return { ok: false, message: 'API Key 无效' }
    }
    if (response.status === 404) {
      return { ok: false, message: 'Base Url 无效' }
    }
    if (!response.ok) {
      return { ok: false, message: '配置错误' }
    }

    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }
    const models = (payload.data ?? [])
      .map((entry) => (typeof entry.id === 'string' ? entry.id.trim() : ''))
      .filter((id) => id.length > 0)
      .sort((a, b) => a.localeCompare(b))

    if (models.length === 0) {
      return { ok: false, message: '配置错误' }
    }

    return { ok: true, models }
  } catch {
    return { ok: false, message: '配置错误' }
  }
}

/**
 * 执行交互式 init 向导并写入目标 `config.toml`。
 *
 * @returns 进程退出码（未知参数为 2，配置校验失败为 1）
 */
export async function runInitCli(options: RunInitCliOptions): Promise<number> {
  const { targets, unknownArgs } = parseInitCliArgs(options.argv)
  const cwd = options.cwd ?? process.cwd()
  const paths = getRuntimeConfigPaths(cwd)
  const readlinePrompts = options.prompts ? undefined : createReadlinePrompts()
  const prompts = options.prompts ?? readlinePrompts!.prompts
  const fetchModels = options.fetchModels ?? fetchOpenAiModels

  const configPaths = targets.map((target) =>
    target === 'local' ? paths.projectConfigPath : paths.userConfigPath
  )

  try {
    if (unknownArgs.length > 0) {
      prompts.error(`未知 init 参数: ${unknownArgs.join(' ')}`)
      prompts.error('可用选项: --local, -l, --user, -u')
      return 2
    }

    for (const configPath of configPaths) {
      prompts.log(`\n初始化配置: ${configPath}`)
      const code = await runInitWizard({
        configPath,
        prompts,
        fetchModels
      })
      if (code !== 0) return code
    }

    prompts.log('\n配置完成。')
    return 0
  } finally {
    readlinePrompts?.close()
  }
}

async function runInitWizard(options: {
  configPath: string
  prompts: InitPrompts
  fetchModels: (baseUrl: string, apiKey: string) => Promise<FetchOpenAiModelsResult>
}): Promise<number> {
  const entries = readTomlConfigFile(options.configPath)

  options.prompts.log('\n=== 主模型 ===')
  const openai = await configureOpenAiSection({
    sectionLabel: '主模型',
    existing: readSection(entries, 'openai'),
    prompts: options.prompts,
    fetchModels: options.fetchModels
  })
  if (!openai) return 1
  writeSection(entries, 'openai', openai)

  options.prompts.log('\n=== 摘要模型 ===')
  const sameAsMain = await options.prompts.confirm('是否与主模型保持一致？', true)
  let summary: OpenAiSectionConfig
  if (sameAsMain) {
    summary = { ...openai }
  } else {
    const configured = await configureOpenAiSection({
      sectionLabel: '摘要模型',
      existing: readSection(entries, 'summary'),
      prompts: options.prompts,
      fetchModels: options.fetchModels
    })
    if (!configured) return 1
    summary = configured
  }
  writeSection(entries, 'summary', summary)

  options.prompts.log('\n=== 环境变量 ===')
  const useEnvFile = await options.prompts.confirm('是否使用 env 文件？', false)
  if (useEnvFile) {
    const existingEnvFile = typeof entries.env?.file === 'string' ? entries.env.file : '.env'
    const envFile = (
      await options.prompts.question(`env 文件相对路径 [${existingEnvFile}]: `, existingEnvFile)
    ).trim()
    entries.env = { file: envFile || '.env' }
  } else {
    delete entries.env
  }

  options.prompts.log('\n=== GitLab Wiki 集成 ===')
  const enableGitlabKb = await options.prompts.confirm('是否启用 GitLab Wiki 集成？', false)
  if (enableGitlabKb) {
    const gitlabKb = await configureGitlabKbSection({ entries, prompts: options.prompts })
    if (!gitlabKb) return 1
    entries.gitlab_kb = {
      url: gitlabKb.url,
      token: gitlabKb.token,
      prefix: gitlabKb.prefix
    }
  } else {
    delete entries.gitlab_kb
  }

  writeTomlConfigFile(options.configPath, entries)
  return 0
}

async function configureOpenAiSection(options: {
  sectionLabel: string
  existing: Partial<OpenAiSectionConfig>
  prompts: InitPrompts
  fetchModels: (baseUrl: string, apiKey: string) => Promise<FetchOpenAiModelsResult>
}): Promise<OpenAiSectionConfig | undefined> {
  const baseUrl = (
    await options.prompts.question(
      `OpenAI Base Url [${options.existing.base_url ?? DEFAULT_OPENAI_BASE_URL}]: `,
      options.existing.base_url ?? DEFAULT_OPENAI_BASE_URL
    )
  ).trim()

  const apiKeyInput = (
    await options.prompts.question(
      `OpenAI API Key${options.existing.api_key ? ' (留空保持不变)' : ''}: `,
      options.existing.api_key
    )
  ).trim()
  const apiKey = apiKeyInput || options.existing.api_key?.trim() || ''

  if (!apiKey) {
    options.prompts.error('配置错误')
    return undefined
  }

  const modelsResult = await options.fetchModels(baseUrl, apiKey)
  if (!modelsResult.ok) {
    options.prompts.error(modelsResult.message)
    return undefined
  }

  const model = await options.prompts.chooseModel(modelsResult.models, options.sectionLabel)
  return { base_url: baseUrl, api_key: apiKey, model }
}

function readSection(
  entries: TomlConfigEntries,
  section: string
): Partial<OpenAiSectionConfig> {
  const sectionEntries = entries[section]
  if (!sectionEntries) return {}

  return {
    base_url:
      typeof sectionEntries.base_url === 'string' ? sectionEntries.base_url : undefined,
    api_key: typeof sectionEntries.api_key === 'string' ? sectionEntries.api_key : undefined,
    model: typeof sectionEntries.model === 'string' ? sectionEntries.model : undefined
  }
}

function writeSection(
  entries: TomlConfigEntries,
  section: string,
  config: OpenAiSectionConfig
): void {
  entries[section] = {
    base_url: config.base_url,
    api_key: config.api_key,
    model: config.model
  }
}

/** 根据 OpenAI 兼容 base_url 构造 `/models` 请求地址。 */
export function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return `${trimmed}/models`
}

/** 交互式收集 `[gitlab_kb]` 的 url、token 与 prefix。 */
async function configureGitlabKbSection(options: {
  entries: TomlConfigEntries
  prompts: InitPrompts
}): Promise<GitLabKbSectionConfig | undefined> {
  const existingUrl =
    typeof options.entries.gitlab_kb?.url === 'string' ? options.entries.gitlab_kb.url : ''
  const existingToken =
    typeof options.entries.gitlab_kb?.token === 'string' ? options.entries.gitlab_kb.token : ''
  const existingPrefix =
    typeof options.entries.gitlab_kb?.prefix === 'string' ? options.entries.gitlab_kb.prefix : ''

  const url = (
    await options.prompts.question(
      `GitLab Url${existingUrl ? ` [${existingUrl}]` : ''}: `,
      existingUrl || undefined
    )
  ).trim()

  const tokenInput = (
    await options.prompts.question(
      `GitLab User Token${existingToken ? ' (留空保持不变)' : ''}: `,
      existingToken || undefined
    )
  ).trim()
  const token = tokenInput || existingToken.trim()

  const prefixDefault = existingPrefix || 'q-code-kb'
  const prefix = (
    await options.prompts.question(`Prefix [${prefixDefault}]: `, prefixDefault)
  ).trim()

  if (!url || !token) {
    options.prompts.error('配置错误')
    return undefined
  }

  return { url, token, prefix: prefix || prefixDefault }
}

function createReadlinePrompts(): { prompts: InitPrompts; close: () => void } {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return {
    prompts: {
      log: (text) => {
        process.stdout.write(`${text}\n`)
      },
      error: (text) => {
        process.stderr.write(`${text}\n`)
      },
      question: (prompt, defaultValue) => askLine(rl, prompt, defaultValue),
      confirm: (prompt, defaultYes) => askConfirm(rl, prompt, defaultYes),
      chooseModel: (models, sectionLabel) => askModelChoice(rl, models, sectionLabel)
    },
    close: () => rl.close()
  }
}

function askLine(rl: Interface, prompt: string, defaultValue?: string): Promise<string> {
  return new Promise((resolvePromise) => {
    rl.question(prompt, (answer) => {
      const trimmed = answer.trim()
      if (trimmed) {
        resolvePromise(trimmed)
        return
      }
      resolvePromise(defaultValue ?? '')
    })
  })
}

async function askConfirm(rl: Interface, prompt: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: '
  const answer = (await askLine(rl, `${prompt}${suffix}`)).trim().toLowerCase()
  if (!answer) return defaultYes
  return ['y', 'yes', '是', 'true', '1'].includes(answer)
}

async function askModelChoice(
  rl: Interface,
  models: string[],
  sectionLabel: string
): Promise<string> {
  process.stdout.write(`\n${sectionLabel}可用模型:\n`)
  models.forEach((model, index) => {
    process.stdout.write(`  ${index + 1}. ${model}\n`)
  })

  while (true) {
    const answer = (await askLine(rl, '请选择模型编号或输入模型 id: ')).trim()
    const index = Number(answer)
    if (Number.isInteger(index) && index >= 1 && index <= models.length) {
      return models[index - 1]
    }
    if (models.includes(answer)) return answer
    process.stdout.write('无效选择，请重新输入。\n')
  }
}

/** 解析 init 目标对应的配置文件绝对路径（测试辅助）。 */
export function resolveInitConfigPath(target: InitConfigTarget, cwd: string = process.cwd()): string {
  const paths = getRuntimeConfigPaths(cwd)
  return target === 'local' ? paths.projectConfigPath : paths.userConfigPath
}
