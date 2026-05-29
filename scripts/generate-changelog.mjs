/**
 * 从 git tag 与 conventional commit 生成 CHANGELOG.md 与 changelog.json。
 *
 * 供 CI 与本地 `pnpm changelog` 使用；会过滤 `chore: release` 类提交。
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG_MD = join(ROOT, 'CHANGELOG.md')
const CHANGELOG_JSON = join(ROOT, 'changelog.json')

const TYPE_LABELS = {
  feat: '新功能',
  fix: '修复',
  perf: '性能',
  docs: '文档',
  chore: '维护',
  test: '测试',
  refactor: '重构',
  build: '构建',
  ci: 'CI',
  revert: '回退'
}

function exec(command) {
  return execSync(command, { cwd: ROOT, encoding: 'utf-8' }).trim()
}

function compareSemver(a, b) {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function normalizeTag(tag) {
  return tag.replace(/^v/i, '')
}

function parseConventionalCommit(subject) {
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/)
  if (!match) {
    return { type: 'other', scope: undefined, message: subject }
  }
  return { type: match[1], scope: match[2], message: match[3] }
}

function isReleaseCommit(subject) {
  return /^chore:\s*release\b/i.test(subject)
}

function getPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
}

function getVersionTags() {
  const raw = exec('git tag -l "v*"')
  if (!raw) return []
  const unique = [...new Set(raw.split('\n').map(normalizeTag).filter(Boolean))]
  return unique.sort(compareSemver)
}

function getCommitsInRange(range) {
  try {
    const log = exec(
      `git log ${range} --pretty=format:'%h|%s|%ad' --date=short`
    )
    if (!log) return []
    return log
      .split('\n')
      .map((line) => {
        const [hash, subject, date] = line.split('|')
        const parsed = parseConventionalCommit(subject)
        return {
          hash,
          subject,
          date,
          type: parsed.type,
          scope: parsed.scope,
          message: parsed.message
        }
      })
      .filter((entry) => !isReleaseCommit(entry.subject))
  } catch {
    return []
  }
}

function getReleaseDate(version, changes) {
  if (changes.length > 0) return changes[0].date
  try {
    return exec(`git log -1 --format=%ad --date=short v${version}`)
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function buildReleases(tags, packageVersion) {
  const releases = []
  for (let i = 0; i < tags.length; i += 1) {
    const version = tags[i]
    const fromTag = i > 0 ? `v${tags[i - 1]}` : undefined
    const range = fromTag ? `${fromTag}..v${version}` : `v${version}`
    const changes = getCommitsInRange(range)
    releases.push({
      version,
      date: getReleaseDate(version, changes),
      changes
    })
  }

  const latestTag = tags.at(-1)
  if (!latestTag || compareSemver(packageVersion, latestTag) > 0) {
    const range = latestTag ? `v${latestTag}..HEAD` : 'HEAD'
    const changes = getCommitsInRange(range)
    if (changes.length > 0) {
      releases.push({
        version: packageVersion,
        date: changes[0].date,
        changes
      })
    }
  }

  return releases.sort((a, b) => compareSemver(b.version, a.version))
}

function formatChangeLine(change) {
  const label = TYPE_LABELS[change.type] ?? TYPE_LABELS.other ?? '其他'
  const scope = change.scope ? `**${change.scope}** ` : ''
  return `- ${label}: ${scope}${change.message}`
}

function renderMarkdown(releases, packageVersion) {
  const lines = [
    '# Changelog',
    '',
    '本文件由 CI 根据 git tag 与 conventional commit 自动生成。',
    '',
    `当前版本：**${packageVersion}**`,
    ''
  ]

  for (const release of releases) {
    lines.push(`## ${release.version} (${release.date})`)
    lines.push('')
    if (release.changes.length === 0) {
      lines.push('- 无用户可见变更')
      lines.push('')
      continue
    }
    for (const change of release.changes) {
      lines.push(formatChangeLine(change))
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function main() {
  const packageVersion = getPackageVersion()
  const tags = getVersionTags()
  const releases = buildReleases(tags, packageVersion)
  const payload = {
    generatedAt: new Date().toISOString(),
    currentVersion: packageVersion,
    releases
  }

  writeFileSync(CHANGELOG_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  writeFileSync(CHANGELOG_MD, renderMarkdown(releases, packageVersion), 'utf-8')

  console.log(`Wrote ${CHANGELOG_MD}`)
  console.log(`Wrote ${CHANGELOG_JSON}`)
  console.log(`Releases: ${releases.length}`)
}

main()
