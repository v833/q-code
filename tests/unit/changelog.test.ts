import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareSemver,
  formatChangelogNotice,
  getLastSeenVersionPath,
  getReleasesSince,
  loadChangelog,
  maybeShowChangelogNotice,
  readLastSeenVersion,
  shouldShowChangelog,
  type ChangelogData
} from '../../src/runtime/changelog'

const sampleChangelog: ChangelogData = {
  generatedAt: '2026-05-29T00:00:00.000Z',
  currentVersion: '1.2.3',
  releases: [
    {
      version: '1.2.3',
      date: '2026-05-28',
      changes: [
        {
          hash: 'abc123',
          subject: 'feat: add models picker (#53)',
          date: '2026-05-28',
          type: 'feat',
          scope: undefined,
          message: 'add models picker (#53)'
        }
      ]
    },
    {
      version: '1.2.2',
      date: '2026-05-20',
      changes: [
        {
          hash: 'def456',
          subject: 'fix: stabilize sessions picker (#50)',
          date: '2026-05-20',
          type: 'fix',
          scope: undefined,
          message: 'stabilize sessions picker (#50)'
        }
      ]
    }
  ]
}

describe('changelog', () => {
  const homes: string[] = []

  afterEach(() => {
    for (const home of homes.splice(0)) {
      delete process.env.Q_CODE_HOME
      void home
    }
  })

  function withHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'q-code-changelog-'))
    homes.push(home)
    process.env.Q_CODE_HOME = home
    return home
  }

  it('compares semver versions', () => {
    expect(compareSemver('1.2.3', '1.2.2')).toBeGreaterThan(0)
    expect(compareSemver('1.2.2', '1.2.3')).toBeLessThan(0)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('filters releases since a previous version', () => {
    const releases = getReleasesSince(sampleChangelog, '1.2.2', '1.2.3')
    expect(releases.map((release) => release.version)).toEqual(['1.2.3'])
  })

  it('returns no releases for first install', () => {
    expect(getReleasesSince(sampleChangelog, undefined, '1.2.3')).toEqual([])
  })

  it('formats changelog notice in Chinese', () => {
    const releases = getReleasesSince(sampleChangelog, '1.2.2', '1.2.3')
    const notice = formatChangelogNotice(releases, '1.2.2', '1.2.3')
    expect(notice).toContain('q-code 已更新：v1.2.2 → v1.2.3')
    expect(notice).toContain('新功能: add models picker (#53)')
  })

  it('loads changelog json from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'q-code-changelog-json-'))
    const filePath = join(dir, 'changelog.json')
    writeFileSync(filePath, JSON.stringify(sampleChangelog), 'utf-8')
    expect(loadChangelog(filePath)?.currentVersion).toBe('1.2.3')
  })

  it('shows changelog on version upgrade and persists last seen version', async () => {
    const home = withHome()
    const lastSeenPath = getLastSeenVersionPath()
    writeFileSync(
      lastSeenPath,
      JSON.stringify({ version: '1.2.2', seenAt: '2026-05-20T00:00:00.000Z' }),
      'utf-8'
    )

    const changelogPath = join(home, 'changelog.json')
    writeFileSync(changelogPath, JSON.stringify(sampleChangelog), 'utf-8')

    const printed: string[] = []
    await maybeShowChangelogNotice({
      currentVersion: '1.2.3',
      changelogPath,
      print: (text) => printed.push(text),
      env: {
        Q_CODE_HOME: home,
        Q_CODE_CHANGELOG: '1'
      }
    })

    expect(printed.join('\n')).toContain('q-code 已更新：v1.2.2 → v1.2.3')
    expect(JSON.parse(readFileSync(lastSeenPath, 'utf-8')).version).toBe('1.2.3')
  })

  it('does not show changelog on first install', async () => {
    const home = withHome()
    const changelogPath = join(home, 'changelog.json')
    writeFileSync(changelogPath, JSON.stringify(sampleChangelog), 'utf-8')

    const printed: string[] = []
    await maybeShowChangelogNotice({
      currentVersion: '1.2.3',
      changelogPath,
      print: (text) => printed.push(text),
      env: { Q_CODE_HOME: home }
    })

    expect(printed).toEqual([])
    expect(readLastSeenVersion()?.version).toBe('1.2.3')
  })

  it('respects Q_CODE_CHANGELOG=0', async () => {
    const home = withHome()
    mkdirSync(home, { recursive: true })
    writeFileSync(
      getLastSeenVersionPath(),
      JSON.stringify({ version: '1.2.2', seenAt: '2026-05-20T00:00:00.000Z' }),
      'utf-8'
    )
    writeFileSync(join(home, 'changelog.json'), JSON.stringify(sampleChangelog), 'utf-8')

    const printed: string[] = []
    await maybeShowChangelogNotice({
      currentVersion: '1.2.3',
      changelogPath: join(home, 'changelog.json'),
      print: (text) => printed.push(text),
      env: { Q_CODE_HOME: home, Q_CODE_CHANGELOG: '0' }
    })

    expect(printed).toEqual([])
    expect(readLastSeenVersion()?.version).toBe('1.2.3')
  })

  it('can disable changelog via env', () => {
    expect(shouldShowChangelog({ Q_CODE_CHANGELOG: '0' })).toBe(false)
    expect(shouldShowChangelog({})).toBe(true)
  })
})
