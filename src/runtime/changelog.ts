/**
 * 启动时展示自上次使用以来的版本更新说明。
 *
 * 读取包内 `changelog.json`，对比 `~/.q-code/last-version.json` 记录的上次版本。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeJsonAtomic } from '../utils/atomic-write'

/** 单条 changelog 记录。 */
export interface ChangelogEntry {
  hash: string
  subject: string
  date: string
  type: string
  scope?: string
  message: string
}

/** 单个版本的 changelog 分组。 */
export interface ChangelogRelease {
  version: string
  date: string
  changes: ChangelogEntry[]
}

/** `changelog.json` 根结构。 */
export interface ChangelogData {
  generatedAt: string
  currentVersion: string
  releases: ChangelogRelease[]
}

/** 用户上次使用时的版本记录。 */
export interface LastSeenVersion {
  version: string
  seenAt: string
}

const TYPE_LABELS: Record<string, string> = {
  feat: '新功能',
  fix: '修复',
  perf: '性能',
  docs: '文档',
  chore: '维护',
  test: '测试',
  refactor: '重构',
  build: '构建',
  ci: 'CI',
  revert: '回退',
  other: '其他'
}

/**
 * 比较两个 semver 字符串。
 *
 * @returns 正数表示 a 更新，负数表示 b 更新，0 表示相同
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 是否启用启动 changelog 提示（默认开启，`Q_CODE_CHANGELOG=0` 关闭）。 */
export function shouldShowChangelog(
  env: { Q_CODE_CHANGELOG?: string | undefined } = process.env
): boolean {
  const value = env.Q_CODE_CHANGELOG?.trim().toLowerCase()
  if (!value) return true
  return !['0', 'false', 'no', 'off'].includes(value)
}

/** 解析 `Q_CODE_HOME` 或默认 `~/.q-code`。 */
export function resolveQCodeHome(
  env: { Q_CODE_HOME?: string | undefined } = process.env
): string {
  const configured = env.Q_CODE_HOME?.trim()
  return configured ? join(configured) : join(homedir(), '.q-code')
}

/** 上次使用版本文件路径。 */
export function getLastSeenVersionPath(
  env: { Q_CODE_HOME?: string | undefined } = process.env
): string {
  return join(resolveQCodeHome(env), 'last-version.json')
}

/** 从包目录向上查找 `changelog.json`。 */
export function resolveChangelogPath(startDir = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let current = startDir
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'changelog.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/** 读取并解析 `changelog.json`。 */
export function loadChangelog(filePath: string): ChangelogData | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as ChangelogData
    if (!parsed || typeof parsed.currentVersion !== 'string' || !Array.isArray(parsed.releases)) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

/** 读取用户上次使用版本；文件缺失或损坏时返回 `undefined`。 */
export function readLastSeenVersion(
  env: { Q_CODE_HOME?: string | undefined } = process.env
): LastSeenVersion | undefined {
  const filePath = getLastSeenVersionPath(env)
  if (!existsSync(filePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as LastSeenVersion
    if (!parsed || typeof parsed.version !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 持久化当前版本为“上次使用版本”。 */
export async function writeLastSeenVersion(
  version: string,
  env: { Q_CODE_HOME?: string | undefined } = process.env
): Promise<void> {
  const filePath = getLastSeenVersionPath(env)
  mkdirSync(dirname(filePath), { recursive: true })
  const payload: LastSeenVersion = {
    version,
    seenAt: new Date().toISOString()
  }
  await writeJsonAtomic(filePath, payload)
}

/**
 * 获取自 `sinceVersion` 之后到 `currentVersion`（含）的 release 列表。
 *
 * `sinceVersion` 缺失时返回空数组（视为首次安装，不打扰用户）。
 */
export function getReleasesSince(
  data: ChangelogData,
  sinceVersion: string | undefined,
  currentVersion: string
): ChangelogRelease[] {
  if (!sinceVersion || compareSemver(sinceVersion, currentVersion) >= 0) return []
  return data.releases
    .filter(
      (release) =>
        compareSemver(release.version, sinceVersion) > 0 &&
        compareSemver(release.version, currentVersion) <= 0
    )
    .sort((a, b) => compareSemver(b.version, a.version))
}

function formatChangeLine(change: ChangelogEntry): string {
  const label = TYPE_LABELS[change.type] ?? TYPE_LABELS.other
  const scope = change.scope ? `${change.scope}: ` : ''
  return `  - ${label}: ${scope}${change.message}`
}

/**
 * 将版本区间内的 changelog 渲染为多行文本。
 */
export function formatChangelogNotice(
  releases: readonly ChangelogRelease[],
  fromVersion: string | undefined,
  toVersion: string
): string {
  if (releases.length === 0) return ''
  const header = fromVersion
    ? `q-code 已更新：v${fromVersion} → v${toVersion}`
    : `q-code 更新说明：v${toVersion}`
  const sections = releases.map((release) => {
    const lines = [`v${release.version} (${release.date})`]
    if (release.changes.length === 0) {
      lines.push('  - 无用户可见变更')
      return lines.join('\n')
    }
    for (const change of release.changes) {
      lines.push(formatChangeLine(change))
    }
    return lines.join('\n')
  })
  return [header, '', ...sections].join('\n')
}

/** 启动时检测版本变化并输出 changelog；始终更新 last-version 记录。 */
export async function maybeShowChangelogNotice(options: {
  currentVersion: string
  print: (text: string) => void
  changelogPath?: string
  env?: { Q_CODE_HOME?: string | undefined; Q_CODE_CHANGELOG?: string | undefined }
}): Promise<void> {
  const env = options.env ?? process.env
  const lastSeen = readLastSeenVersion(env)
  const changelogPath = options.changelogPath ?? resolveChangelogPath()
  const changelog = changelogPath ? loadChangelog(changelogPath) : undefined

  if (
    shouldShowChangelog(env) &&
    changelog &&
    lastSeen &&
    compareSemver(lastSeen.version, options.currentVersion) < 0
  ) {
    const releases = getReleasesSince(changelog, lastSeen.version, options.currentVersion)
    const notice = formatChangelogNotice(releases, lastSeen.version, options.currentVersion)
    if (notice) options.print(notice)
  }

  if (!lastSeen || lastSeen.version !== options.currentVersion) {
    await writeLastSeenVersion(options.currentVersion, env)
  }
}
