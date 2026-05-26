/**
 * 企业 AI 基建（Infra）环境变量与客户端标识加载。
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import type { InfraConfig, InfraUserInfo } from './types'

const DEFAULT_TIMEOUT_MS = 5000

/**
 * 从 `process.env` 加载 Infra 运行时配置。
 *
 * 缺省不启用；启用后需配合 `Q_CODE_INFRA_BASE_URL` 与 `Q_CODE_INFRA_TOKEN` 使用。
 */
export function loadInfraConfig(): InfraConfig {
  const baseUrl = clean(process.env.Q_CODE_INFRA_BASE_URL)
  const token = clean(process.env.Q_CODE_INFRA_TOKEN)
  const enabledRaw = clean(process.env.Q_CODE_INFRA_ENABLED)
  const syncRaw = clean(process.env.Q_CODE_INFRA_SYNC)
  const enabled = isTrue(enabledRaw)
  const clientId = getClientId()
  const cacheDir = path.resolve(
    clean(process.env.Q_CODE_INFRA_CACHE_DIR) ?? path.join(os.homedir(), '.q-code', 'infra')
  )
  const timeoutMs = getPositiveNumber(process.env.Q_CODE_INFRA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)

  return {
    enabled,
    baseUrl,
    token,
    clientId,
    cacheDir,
    syncOnStartup: enabled && !isFalse(syncRaw),
    uploadSource: isTrue(clean(process.env.Q_CODE_INFRA_UPLOAD_SOURCE)),
    timeoutMs
  }
}

/**
 * 加载上报给管理端的用户身份信息。
 *
 * `id` 可来自 `Q_CODE_INFRA_USER_ID`，否则回退到系统用户名。
 */
export function loadInfraUserInfo(): InfraUserInfo {
  return {
    id: clean(process.env.Q_CODE_INFRA_USER_ID) ?? clean(process.env.USERNAME) ?? clean(process.env.USER),
    name: clean(process.env.Q_CODE_INFRA_USER_NAME),
    groups: splitList(process.env.Q_CODE_INFRA_USER_GROUPS)
  }
}

function getClientId(): string {
  const explicit = clean(process.env.Q_CODE_INFRA_CLIENT_ID)
  if (explicit) return explicit

  const idFile = path.join(os.homedir(), '.q-code', 'infra-client-id')
  try {
    const existing = fs.readFileSync(idFile, 'utf-8').trim()
    if (existing) return existing
  } catch {
    // 下方生成新 ID
  }

  const generated = randomUUID()
  try {
    fs.mkdirSync(path.dirname(idFile), { recursive: true })
    fs.writeFileSync(idFile, `${generated}\n`, 'utf-8')
  } catch {
    // 无法持久化时，本进程内仍使用本次生成的值
  }
  return generated
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isFalse(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes((value ?? '').toLowerCase())
}

function isTrue(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase())
}

function getPositiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}
