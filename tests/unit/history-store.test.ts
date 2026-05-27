import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHistoryStore,
  formatHistoryEntries,
  type HistoryEntry
} from '../../src/terminal/history-store'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('history store', () => {
  it('filters empty, leading-space, sensitive, and consecutive duplicate inputs', async () => {
    const { cwd, home } = createRoots()
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      now: createClock(),
      env: { Q_CODE_HISTORY_SCOPE: 'project' }
    })

    await store.append('pnpm test')
    await store.append(' pnpm secret')
    await store.append('api_key=xxx')
    await store.append('pnpm test')
    await store.append('pnpm typecheck')
    await store.append('pnpm test')

    expect(await store.load()).toEqual(['pnpm typecheck', 'pnpm test'])
    const lines = readJsonl(join(cwd, '.q-code', 'history.jsonl'))
    expect(lines).toHaveLength(3)
  })

  it('loads project and global history by recency while deduplicating values', async () => {
    const { cwd, home } = createRoots()
    const projectPath = join(cwd, '.q-code', 'history.jsonl')
    const globalPath = join(home, 'history', 'global.jsonl')
    mkdirSync(join(cwd, '.q-code'), { recursive: true })
    mkdirSync(join(home, 'history'), { recursive: true })
    writeFileSync(
      projectPath,
      [
        line({ ts: '2026-05-27T10:00:00.000Z', value: 'shared', sessionId: 'p' }),
        line({ ts: '2026-05-27T09:00:00.000Z', value: 'project only', sessionId: 'p' })
      ].join('')
    )
    writeFileSync(
      globalPath,
      [
        line({ ts: '2026-05-27T10:00:00.000Z', value: 'shared', sessionId: 'g' }),
        line({ ts: '2026-05-27T08:00:00.000Z', value: 'global only', sessionId: 'g' })
      ].join('')
    )

    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      env: { Q_CODE_HISTORY_SCOPE: 'both' }
    })

    const entries = await store.loadEntries(10)
    expect(entries.map((entry) => `${entry.scope}:${entry.value}`)).toEqual([
      'project:shared',
      'project:project only',
      'global:global only'
    ])
    expect(await store.load()).toEqual(['global only', 'project only', 'shared'])
  })

  it('rotates history files by line count', async () => {
    const { cwd, home } = createRoots()
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      now: createClock(),
      env: {
        Q_CODE_HISTORY_SCOPE: 'project',
        Q_CODE_HISTORY_MAX_LINES: '3',
        Q_CODE_HISTORY_MAX_BYTES: '1048576'
      }
    })

    for (let index = 0; index < 5; index += 1) {
      await store.append(`cmd ${index}`)
    }

    expect(await store.load()).toEqual(['cmd 2', 'cmd 3', 'cmd 4'])
    expect(readJsonl(join(cwd, '.q-code', 'history.jsonl'))).toHaveLength(3)
  })

  it('supports concurrent appends without corrupting JSONL', async () => {
    const { cwd, home } = createRoots()
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      env: { Q_CODE_HISTORY_SCOPE: 'project' }
    })

    await Promise.all(Array.from({ length: 20 }, (_, index) => store.append(`cmd ${index}`)))

    const lines = readJsonl(join(cwd, '.q-code', 'history.jsonl'))
    expect(lines).toHaveLength(20)
    expect(lines.map((entry) => entry.value).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `cmd ${index}`).sort()
    )
  })

  it('redacts stored values and can clear the selected scope', async () => {
    const { cwd, home } = createRoots()
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      env: {
        Q_CODE_HISTORY_SCOPE: 'global',
        Q_CODE_HISTORY_REDACT: 'true'
      }
    })

    await store.append('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')
    const lines = readJsonl(join(home, 'history', 'global.jsonl'))
    expect(lines[0]).toMatchObject({
      value: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
      redacted: true
    })
    expect(lines[0]?.sha256).toHaveLength(64)

    await store.clear('global')
    expect(readFileSync(join(home, 'history', 'global.jsonl'), 'utf-8')).toBe('')
  })

  it('deduplicates redacted history by hash instead of preview text', async () => {
    const { cwd, home } = createRoots()
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      now: createClock(),
      env: {
        Q_CODE_HISTORY_SCOPE: 'project',
        Q_CODE_HISTORY_REDACT: 'true'
      }
    })

    await store.append(`${'a'.repeat(50)}1`)
    await store.append(`${'a'.repeat(50)}2`)

    const lines = readJsonl(join(cwd, '.q-code', 'history.jsonl'))
    expect(lines).toHaveLength(2)
    expect(lines[0]?.value).toBe(lines[1]?.value)
    expect(lines[0]?.sha256).not.toBe(lines[1]?.sha256)
    expect(await store.load()).toHaveLength(2)
  })

  it('does not follow a project .q-code symlink outside the cwd', async () => {
    const { cwd, home, root } = createRoots()
    const outside = join(root, 'outside-q-code')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(cwd, '.q-code'), process.platform === 'win32' ? 'junction' : 'dir')
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      env: { Q_CODE_HISTORY_SCOPE: 'project' }
    })

    const result = await store.append('pnpm test')

    expect(result.persisted).toBe(false)
    expect(existsSync(join(outside, 'history.jsonl'))).toBe(false)
    expect(await store.load()).toEqual([])
  })

  it('bounds history sizing config to conservative limits', () => {
    const { cwd, home } = createRoots()
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      env: {
        Q_CODE_HISTORY_SCOPE: 'project',
        Q_CODE_HISTORY_MAX_LINES: '9999999',
        Q_CODE_HISTORY_MAX_BYTES: '1',
        Q_CODE_HISTORY_RUNTIME_LIMIT: '9999999',
        Q_CODE_HISTORY_MAX_LINE_BYTES: '9999999'
      }
    })

    expect(store.getConfig()).toMatchObject({
      maxLines: 1_000_000,
      runtimeLimit: 100_000,
      maxLineBytes: 1024 * 1024,
      maxBytes: 5 * 1024 * 1024
    })
  })

  it('reads exclude patterns and search mode from history settings', async () => {
    const { cwd, home } = createRoots()
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      env: { Q_CODE_HISTORY_SCOPE: 'project' },
      settings: {
        excludePatterns: ['^secret:'],
        search: 'fuzzy'
      }
    })

    expect(store.getSearchMode()).toBe('fuzzy')
    expect(store.shouldRecord('secret:value')).toBe(false)
    await store.append('pnpm typecheck')
    expect((await store.search('ptc')).map((entry) => entry.value)).toEqual(['pnpm typecheck'])
  })

  it('can disable default sensitive-history filters from settings', async () => {
    const { cwd, home } = createRoots()
    const store = createHistoryStore({
      cwd,
      qCodeHome: home,
      sessionId: 's1',
      env: { Q_CODE_HISTORY_SCOPE: 'project' },
      settings: {
        excludeDefaults: false
      }
    })

    expect(store.shouldRecord('api_key=xxx')).toBe(true)
    await store.append('api_key=xxx')
    expect(await store.load()).toEqual(['api_key=xxx'])
  })

  it('formats recent history for slash output', () => {
    expect(
      formatHistoryEntries([
        {
          ts: '2026-05-27T10:00:00.000Z',
          sessionId: 's1',
          cwd: '/repo',
          value: 'pnpm test',
          chars: 9,
          scope: 'project'
        }
      ])
    ).toContain('[project] 2026-05-27 10:00  pnpm test')
  })
})

function createRoots(): { root: string; cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'q-code-history-'))
  roots.push(root)
  const cwd = join(root, 'repo')
  const home = join(root, 'home')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(home, { recursive: true })
  return { root, cwd, home }
}

function createClock(): () => Date {
  let offset = 0
  return () => new Date(Date.UTC(2026, 4, 27, 10, 0, offset++))
}

function line(entry: Partial<HistoryEntry> & { value: string; ts: string; sessionId: string }): string {
  return `${JSON.stringify({
    cwd: '/repo',
    chars: entry.value.length,
    ...entry
  })}\n`
}

function readJsonl(filePath: string): HistoryEntry[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoryEntry)
}
