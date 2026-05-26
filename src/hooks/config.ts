/**
 * Hook 配置加载：从用户/项目 `settings.json` 解析 command 型 Hook 定义。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { HookCommandDefinition, HookDefinition, HookEventName, HookMatcher, HookScope } from './types'

const HOOK_EVENTS: HookEventName[] = [
  'session_start',
  'session_end',
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
  'stop',
  'subagent_start',
  'subagent_stop'
]

interface RawSettings {
  hooks?: unknown
}

/** `loadHookConfigs` 的返回结构。 */
export interface HookConfigLoadResult {
  hooks: HookDefinition[]
  errors: string[]
  userSettingsPath: string
  projectSettingsPath: string
}

/** 返回用户级与项目级 Hook 配置文件路径。 */
export function getHookSettingsPaths(cwd: string = process.cwd()): {
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

/** 加载并合并用户与项目 Hook 配置；解析错误写入 errors 数组。 */
export async function loadHookConfigs(cwd: string = process.cwd()): Promise<HookConfigLoadResult> {
  const { userSettingsPath, projectSettingsPath } = getHookSettingsPaths(cwd)
  const errors: string[] = []
  const [userFile, projectFile] = await Promise.all([
    readJsonFile<RawSettings>(userSettingsPath),
    readJsonFile<RawSettings>(projectSettingsPath)
  ])

  if (userFile.parseError) errors.push(userFile.parseError)
  if (projectFile.parseError) errors.push(projectFile.parseError)

  const userHooks = extractHooks(userFile.raw, 'user', userSettingsPath, errors)
  const projectHooks = extractHooks(projectFile.raw, 'project', projectSettingsPath, errors)

  return {
    hooks: [...userHooks, ...projectHooks],
    errors,
    userSettingsPath,
    projectSettingsPath
  }
}

function extractHooks(
  raw: RawSettings | null,
  scope: HookScope,
  sourcePath: string,
  errors: string[]
): HookDefinition[] {
  if (!raw || raw.hooks === undefined) return []
  if (!isRecord(raw.hooks)) {
    errors.push(`${sourcePath}: 'hooks' must be an object`)
    return []
  }

  const hooks: HookDefinition[] = []
  for (const [event, value] of Object.entries(raw.hooks)) {
    if (!isHookEvent(event)) {
      errors.push(`${sourcePath}: hooks.${event} is not a supported hook event`)
      continue
    }
    if (!Array.isArray(value)) {
      errors.push(`${sourcePath}: hooks.${event} must be an array`)
      continue
    }
    value.forEach((item, index) => {
      const result = validateCommandHook(event, item, scope, sourcePath, index)
      if (result.ok) hooks.push(result.value)
      else errors.push(result.error)
    })
  }

  return hooks
}

function validateCommandHook(
  event: HookEventName,
  raw: unknown,
  scope: HookScope,
  sourcePath: string,
  index: number
): { ok: true; value: HookCommandDefinition } | { ok: false; error: string } {
  const label = `${sourcePath}: hooks.${event}[${index}]`
  if (!isRecord(raw)) return { ok: false, error: `${label} must be an object` }

  const command = raw.command
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { ok: false, error: `${label}.command must be a non-empty string` }
  }

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `${event}:${index}`
  const timeoutMs = raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs)
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return { ok: false, error: `${label}.timeoutMs must be a positive number` }
  }

  const matcherResult = validateMatcher(raw.matcher, label)
  if (!matcherResult.ok) return matcherResult

  return {
    ok: true,
    value: {
      name,
      type: 'command',
      event,
      command: command.trim(),
      scope,
      sourcePath,
      ...(matcherResult.value ? { matcher: matcherResult.value } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(typeof raw.blocking === 'boolean' ? { blocking: raw.blocking } : {})
    }
  }
}

function validateMatcher(
  value: unknown,
  label: string
): { ok: true; value?: HookMatcher } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  if (!isRecord(value)) return { ok: false, error: `${label}.matcher must be an object` }

  const matcher: HookMatcher = {}
  for (const key of ['tool', 'event', 'agentKind', 'agentType'] as const) {
    const item = value[key]
    if (item === undefined) continue
    if (typeof item === 'string') {
      matcher[key] = item as never
      continue
    }
    if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) {
      matcher[key] = item as never
      continue
    }
    return { ok: false, error: `${label}.matcher.${key} must be a string or string[]` }
  }
  return { ok: true, value: matcher }
}

async function readJsonFile<T>(filePath: string): Promise<{ raw: T | null; parseError?: string }> {
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

function isHookEvent(value: string): value is HookEventName {
  return (HOOK_EVENTS as string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
