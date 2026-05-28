import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFileMentionIndexStore,
  fileMentionIndexNotice,
  getFileMentionIndexCachePath,
  searchFileMentionIndex,
  type FileMentionIndex,
  type FileMentionIndexStore
} from '../../src/mentions'

const tempDirs: string[] = []
const stores: FileMentionIndexStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('file mention index cache store', () => {
  it('serves cached candidates synchronously and refreshes the cache in the background path', async () => {
    const cwd = tmp()
    const cachePath = getFileMentionIndexCachePath(cwd)
    writeCachedIndex(cachePath, cwd, ['cached.ts'])
    let buildCalls = 0

    const store = trackStore(
      createFileMentionIndexStore(cwd, {
        maxFiles: 10,
        autoRefresh: false,
        watchFiles: false,
        buildIndex: async () => {
          buildCalls++
          return createIndex(cwd, ['fresh.ts'])
        }
      })
    )

    expect(store.getSnapshot()).toMatchObject({
      source: 'cache',
      cachedSource: 'git',
      files: ['cached.ts']
    })
    expect(buildCalls).toBe(0)

    await store.refresh()

    expect(store.getSnapshot()).toMatchObject({
      source: 'git',
      files: ['fresh.ts']
    })
    expect(buildCalls).toBe(1)
    expect(readCachedFiles(cachePath)).toEqual(['fresh.ts'])
  })

  it('keeps the previous index and exposes a short notice when refresh fails', async () => {
    const cwd = tmp()
    const cachePath = getFileMentionIndexCachePath(cwd)
    writeCachedIndex(cachePath, cwd, ['cached.ts'])
    const store = trackStore(
      createFileMentionIndexStore(cwd, {
        maxFiles: 10,
        autoRefresh: false,
        watchFiles: false,
        buildIndex: async () => {
          throw new Error('boom while scanning generated output')
        }
      })
    )

    const refreshed = await store.refresh()

    expect(refreshed.files).toEqual(['cached.ts'])
    expect(refreshed.error).toContain('boom while scanning')
    expect(fileMentionIndexNotice(refreshed)).toContain('@file 索引刷新失败')
    expect(searchFileMentionIndex(refreshed, 'cached')[0]?.path).toBe('cached.ts')
  })

  it('filters q-code internal paths from older cache files', () => {
    const cwd = tmp()
    const cachePath = getFileMentionIndexCachePath(cwd)
    writeCachedIndex(cachePath, cwd, [
      '.q-code/file-mention-index.json',
      '.sessions/session.jsonl',
      'src/visible.ts'
    ])

    const store = trackStore(
      createFileMentionIndexStore(cwd, {
        maxFiles: 10,
        autoRefresh: false,
        watchFiles: false
      })
    )

    expect(store.getSnapshot().files).toEqual(['src/visible.ts'])
  })

  it('refreshes candidates after files are added during a session', async () => {
    const cwd = tmp()
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'old.ts'), 'old', 'utf-8')
    const store = trackStore(
      createFileMentionIndexStore(cwd, {
        autoRefresh: false,
        watchFiles: false
      })
    )

    expect((await store.refresh()).files).toContain('src/old.ts')
    writeFileSync(join(cwd, 'src', 'new-worker.ts'), 'fresh', 'utf-8')

    const refreshed = await store.refresh()

    expect(refreshed.files).toContain('src/new-worker.ts')
    expect(searchFileMentionIndex(refreshed, 'newworker')[0]?.path).toBe('src/new-worker.ts')
  })

  it('debounces file watcher events into refreshes', async () => {
    const cwd = tmp()
    const files: string[] = []
    let emitWatchEvent: (filename: string) => void = () => undefined
    const watcher = {
      close: vi.fn(),
      on: vi.fn().mockReturnThis()
    }
    const store = trackStore(
      createFileMentionIndexStore(cwd, {
        autoRefresh: false,
        refreshDebounceMs: 20,
        buildIndex: async () => createIndex(cwd, [...files]),
        watchFactory: (_cwd, _options, listener) => {
          emitWatchEvent = (filename) => listener('rename', filename)
          return watcher
        }
      })
    )

    files.push('watched.ts')
    emitWatchEvent('watched.ts')

    await vi.waitFor(
      () => {
        expect(store.getSnapshot().files).toContain('watched.ts')
      },
      { timeout: 3_000, interval: 25 }
    )
    expect(watcher.close).not.toHaveBeenCalled()
  })

  it('falls back to polling and shows a notice when file watching is unavailable', async () => {
    const cwd = tmp()
    const files: string[] = []
    const store = trackStore(
      createFileMentionIndexStore(cwd, {
        autoRefresh: false,
        watchFallbackPollMs: 20,
        buildIndex: async () => createIndex(cwd, [...files]),
        watchFactory: () => {
          throw new Error('watch not supported')
        }
      })
    )

    expect(fileMentionIndexNotice(store.getSnapshot())).toContain('文件监听不可用')
    files.push('polled.ts')

    await vi.waitFor(
      () => {
        expect(store.getSnapshot().files).toContain('polled.ts')
      },
      { timeout: 3_000, interval: 25 }
    )
    expect(fileMentionIndexNotice(store.getSnapshot())).toContain('文件监听不可用')
  })

  it('passes configurable fallback ignore directories to recursive walk', async () => {
    const cwd = tmp()
    mkdirSync(join(cwd, 'generated'), { recursive: true })
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'generated', 'skip.ts'), 'skip', 'utf-8')
    writeFileSync(join(cwd, 'src', 'keep.ts'), 'keep', 'utf-8')
    const store = trackStore(
      createFileMentionIndexStore(cwd, {
        autoRefresh: false,
        watchFiles: false,
        env: { Q_CODE_FILE_INDEX_IGNORE: 'generated' }
      })
    )

    const index = await store.refresh()

    expect(index.files).toContain('src/keep.ts')
    expect(index.files).not.toContain('generated/skip.ts')
  })
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'q-code-file-index-cache-'))
  tempDirs.push(dir)
  return dir
}

function trackStore(store: FileMentionIndexStore): FileMentionIndexStore {
  stores.push(store)
  return store
}

function createIndex(cwd: string, files: string[]): FileMentionIndex {
  return {
    cwd: resolve(cwd),
    files,
    totalFiles: files.length,
    truncated: false,
    source: 'git'
  }
}

function writeCachedIndex(cachePath: string, cwd: string, files: string[]): void {
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(
    cachePath,
    JSON.stringify(
      {
        version: 1,
        cwd: resolve(cwd),
        maxFiles: 10,
        savedAt: '2026-05-28T00:00:00.000Z',
        index: {
          source: 'git',
          files,
          totalFiles: files.length,
          truncated: false
        }
      },
      null,
      2
    ),
    'utf-8'
  )
}

function readCachedFiles(cachePath: string): string[] {
  return JSON.parse(readFileSync(cachePath, 'utf-8')).index.files
}
