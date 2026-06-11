import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSessionModelBoundaryNotice } from '../../src/session/model-boundary'
import {
  deleteSession,
  exportSession,
  listProjectSessions,
  purgeSessions,
  renameSession,
  restoreSession,
  searchSessions,
  SessionStore
} from '../../src/session/store'
import {
  createFileHistoryState,
  createFileHistoryTranscriptRewind,
  makeFileHistorySnapshot,
  recordFileHistoryPostEdit,
  rewindFileHistory,
  snapshotToTranscriptEntry,
  trackFileHistoryEdit
} from '../../src/file-history'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

describe('session management', () => {
  let home: TempHome

  beforeEach(() => {
    home = setupTempHome('session-management-')
  })

  afterEach(() => {
    home.dispose()
  })

  function makeStore(sessionId: string): SessionStore {
    return new SessionStore({
      cwd: home.cwd,
      sessionDir: '.sessions',
      sessionId
    })
  }

  it('defaults session storage to user home sessions', () => {
    const store = new SessionStore({
      cwd: home.cwd,
      sessionId: 'global-default'
    })

    expect(store.paths.rootDir).toBe(join(home.userHome, 'sessions'))
    expect(store.paths.projectDir).toBe(join(home.userHome, 'sessions', store.projectKey))
    expect(store.paths.transcriptPath).toBe(join(home.userHome, 'sessions', store.projectKey, 'global-default.jsonl'))
    expect(existsSync(join(home.cwd, '.sessions'))).toBe(false)
    expect(listProjectSessions({ cwd: home.cwd }).map((session) => session.sessionId)).toEqual(['global-default'])
  })

  it('does not read project .sessions as default storage', () => {
    const legacy = new SessionStore({
      cwd: home.cwd,
      sessionDir: '.sessions',
      sessionId: 'legacy-local'
    })
    legacy.append({ role: 'user', content: 'old local history' })

    const global = new SessionStore({
      cwd: home.cwd,
      sessionId: 'global-current'
    })
    global.append({ role: 'user', content: 'new global history' })

    const otherCwd = join(home.root, 'other-project')
    mkdirSync(otherCwd, { recursive: true })
    const other = new SessionStore({
      cwd: otherCwd,
      sessionId: 'global-other'
    })
    other.append({ role: 'user', content: 'other project history' })

    const sessions = listProjectSessions({ cwd: home.cwd })

    expect(sessions.map((session) => session.sessionId)).toEqual(['global-current'])
    expect(sessions.find((session) => session.sessionId === 'legacy-local')).toBeUndefined()
    expect(sessions.find((session) => session.sessionId === 'global-current')?.transcriptPath).toBe(
      global.paths.transcriptPath
    )
  })

  it('maps project .sessions to the user home session directory in debug mode', () => {
    const store = new SessionStore({
      cwd: home.cwd,
      sessionId: 'debug-link',
      debug: true
    })

    const mappedProjectDir = join(home.cwd, '.sessions', 'projects', store.projectKey)

    expect(lstatSync(mappedProjectDir).isSymbolicLink()).toBe(true)
    expect(realpathSync(mappedProjectDir)).toBe(realpathSync(store.paths.projectDir))
  })

  it('writes and backfills session metadata', () => {
    const store = makeStore('oauth-debug')
    store.append({ role: 'user', content: 'OAuth callback fails after login' })
    store.appendUsage(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    )

    const meta = store.getMetadata()
    expect(meta.sessionId).toBe('oauth-debug')
    expect(meta.messageCount).toBe(1)
    expect(meta.totalTokens).toBe(15)
    expect(meta.lastUserPromptDigest).toContain('OAuth callback')
    expect(existsSync(store.paths.metaPath)).toBe(true)

    const [summary] = listProjectSessions({ cwd: home.cwd, sessionDir: '.sessions' })
    expect(summary?.sessionId).toBe('oauth-debug')
    expect(summary?.lastUserPromptDigest).toContain('OAuth callback')
  })

  it('keeps historical model metadata as diagnostic data only', () => {
    const store = makeStore('historical-model')
    store.appendUsageV2(
      {
        timestamp: '2026-06-01T00:00:00.000Z',
        model: 'old-model',
        cacheMode: 'auto',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15
        },
        pricingModel: 'old-model',
        cost: {
          cost: 0,
          baselineCost: 0,
          savedCost: 0
        }
      },
      {
        steps: 1,
        cacheMode: 'auto',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15
        },
        cost: {
          cost: 0,
          baselineCost: 0,
          savedCost: 0
        },
        unknownCostSteps: 0,
        cacheHitRate: 0
      }
    )

    const reopened = makeStore('historical-model')

    expect(reopened.getSummary().model).toBe('old-model')
    expect(
      createSessionModelBoundaryNotice({
        historicalModel: reopened.getSummary().model,
        currentModel: 'new-model'
      })
    ).toMatchObject({
      historicalModel: 'old-model',
      currentModel: 'new-model'
    })
    expect(
      createSessionModelBoundaryNotice({
        historicalModel: 'old-model',
        currentModel: 'old-model'
      })
    ).toBeUndefined()
  })

  it('persists file history snapshot metadata without file contents', () => {
    const store = makeStore('file-history')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: store.sessionId })
    const snapshot = makeFileHistorySnapshot(state, 'turn-1')
    snapshot.trackedFileBackups['note.txt'] = {
      backupFileName: 'abc@v1',
      version: 1,
      backupTime: '2026-06-11T00:00:00.000Z',
      size: 6,
      contentHash: 'hash-only'
    }
    snapshot.postEditFileStates['note.txt'] = {
      exists: true,
      checkedAt: '2026-06-11T00:00:01.000Z',
      size: 5,
      contentHash: 'post-hash-only'
    }

    store.appendFileHistorySnapshot(snapshotToTranscriptEntry(state, snapshot))
    const reopened = makeStore('file-history')

    expect(reopened.getFileHistorySnapshots()).toEqual([
      expect.objectContaining({
        snapshotId: snapshot.snapshotId,
        turnId: 'turn-1',
        trackedFileBackups: {
          'note.txt': expect.objectContaining({
            backupFileName: 'abc@v1',
            contentHash: 'hash-only'
          })
        },
        postEditFileStates: {
          'note.txt': expect.objectContaining({
            contentHash: 'post-hash-only'
          })
        }
      })
    ])
    expect(readFileSync(store.paths.transcriptPath, 'utf-8')).not.toContain('file body')
  })

  it('persists file history rewind events in transcript order', () => {
    const store = makeStore('file-history-rewind')
    const file = join(home.cwd, 'note.txt')
    writeFileSync(file, 'before', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: store.sessionId })
    const snapshot = makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'note.txt', 'turn-1')
    writeFileSync(file, 'after', 'utf-8')
    recordFileHistoryPostEdit(state, 'note.txt', 'turn-1')

    store.appendFileHistorySnapshot(snapshotToTranscriptEntry(state, snapshot))
    const rewind = rewindFileHistory(state, 1)
    store.appendFileHistoryRewind(createFileHistoryTranscriptRewind(rewind, 1))
    const reopened = makeStore('file-history-rewind')

    expect(reopened.getFileHistoryEvents().map((event) => event.type)).toEqual(['snapshot', 'rewind'])
  })

  it('uses fresh metadata as the list fast path', () => {
    const store = makeStore('metadata-fast-path')
    store.append({ role: 'user', content: 'single transcript message' })
    const metadata = JSON.parse(readFileSync(store.paths.metaPath, 'utf-8')) as Record<string, unknown>
    writeFileSync(
      store.paths.metaPath,
      `${JSON.stringify(
        {
          ...metadata,
          displayName: 'Fast Path',
          messageCount: 42,
          totalTokens: 9001,
          updatedAt: new Date(Date.now() + 1000).toISOString()
        },
        null,
        2
      )}\n`,
      'utf-8'
    )

    const [summary] = listProjectSessions({ cwd: home.cwd, sessionDir: '.sessions' })

    expect(summary?.displayName).toBe('Fast Path')
    expect(summary?.messageCount).toBe(42)
    expect(summary?.totalTokens).toBe(9001)
  })

  it('renames sessions without changing transcript id', () => {
    const store = makeStore('rename-me')
    store.append({ role: 'user', content: 'hello' })

    const meta = renameSession('rename-me', 'OAuth 调试', {
      cwd: home.cwd,
      sessionDir: '.sessions'
    })

    expect(meta.displayName).toBe('OAuth 调试')
    expect(listProjectSessions({ cwd: home.cwd, sessionDir: '.sessions' })[0]?.displayName).toBe('OAuth 调试')
    expect(existsSync(store.paths.transcriptPath)).toBe(true)
  })

  it('does not create a new session when renaming a missing id', () => {
    expect(() =>
      renameSession('missing-session', 'Ghost', {
        cwd: home.cwd,
        sessionDir: '.sessions'
      })
    ).toThrow('Session not found')

    expect(listProjectSessions({ cwd: home.cwd, sessionDir: '.sessions' })).toHaveLength(0)
  })

  it('soft deletes, restores, and force deletes sessions', () => {
    const store = makeStore('trash-me')
    store.append({ role: 'user', content: 'temporary' })

    const deleted = deleteSession('trash-me', { cwd: home.cwd, sessionDir: '.sessions' })
    expect(deleted.trashed).toBe(true)
    expect(listProjectSessions({ cwd: home.cwd, sessionDir: '.sessions' })).toHaveLength(0)
    expect(existsSync(join(store.paths.trashDir, 'trash-me', 'trash-me.jsonl'))).toBe(true)

    const restored = restoreSession('trash-me', { cwd: home.cwd, sessionDir: '.sessions' })
    expect(restored.sessionId).toBe('trash-me')
    expect(existsSync(store.paths.transcriptPath)).toBe(true)

    deleteSession('trash-me', { cwd: home.cwd, sessionDir: '.sessions', force: true })
    expect(existsSync(store.paths.transcriptPath)).toBe(false)
    expect(existsSync(store.paths.metaPath)).toBe(false)
  })

  it('force deletes sessions that are already in trash', () => {
    const store = makeStore('force-trash')
    store.append({ role: 'user', content: 'temporary' })
    deleteSession('force-trash', { cwd: home.cwd, sessionDir: '.sessions' })

    const removed = deleteSession('force-trash', {
      cwd: home.cwd,
      sessionDir: '.sessions',
      force: true
    })

    expect(removed.sessionId).toBe('force-trash')
    expect(removed.trashed).toBe(true)
    expect(existsSync(join(store.paths.trashDir, 'force-trash'))).toBe(false)
  })

  it('exports markdown, json, and html artifacts', () => {
    const store = makeStore('export-me')
    store.updateMetadata({ displayName: 'Export Demo' })
    store.append({ role: 'user', content: 'please summarize' })
    store.append({ role: 'assistant', content: 'summary here' })

    const markdown = exportSession('export-me', { cwd: home.cwd, sessionDir: '.sessions', format: 'md' })
    const json = exportSession('export-me', { cwd: home.cwd, sessionDir: '.sessions', format: 'json' })
    const html = exportSession('export-me', { cwd: home.cwd, sessionDir: '.sessions', format: 'html' })

    expect(readFileSync(markdown.outPath, 'utf-8')).toContain('# q-code 会话 - Export Demo')
    expect(JSON.parse(readFileSync(json.outPath, 'utf-8')).summary.sessionId).toBe('export-me')
    expect(readFileSync(html.outPath, 'utf-8')).toContain('<!doctype html>')
  })

  it('searches message content across sessions', () => {
    makeStore('s1').append({ role: 'user', content: 'OAuth callback investigation' })
    makeStore('s2').append({ role: 'assistant', content: 'worktree notes' })

    const matches = searchSessions('callback', { cwd: home.cwd, sessionDir: '.sessions' })

    expect(matches).toHaveLength(1)
    expect(matches[0]?.sessionId).toBe('s1')
    expect(matches[0]?.snippet).toContain('callback')
  })

  it('purges trashed sessions only after confirmation', () => {
    const store = makeStore('purge-me')
    store.append({ role: 'user', content: 'old' })
    deleteSession('purge-me', { cwd: home.cwd, sessionDir: '.sessions' })

    const preview = purgeSessions({ cwd: home.cwd, sessionDir: '.sessions', olderThanDays: 0 })
    expect(preview.candidates.map((item) => item.sessionId)).toContain('purge-me')
    expect(preview.deleted).toHaveLength(0)
    expect(existsSync(join(store.paths.trashDir, 'purge-me'))).toBe(true)

    const purged = purgeSessions({
      cwd: home.cwd,
      sessionDir: '.sessions',
      olderThanDays: 0,
      confirm: true
    })
    expect(purged.deleted.map((item) => item.sessionId)).toContain('purge-me')
    expect(existsSync(join(store.paths.trashDir, 'purge-me'))).toBe(false)
  })
})
