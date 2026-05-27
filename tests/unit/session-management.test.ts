import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
