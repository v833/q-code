import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startDashboardServer } from '../../src/dashboard/server'
import { SessionStore } from '../../src/session/store'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

describe('dashboard flow', () => {
  let home: TempHome

  beforeEach(() => {
    home = setupTempHome('dashboard-flow-')
  })

  afterEach(() => {
    home.dispose()
  })

  it('serves dashboard html, api snapshot, filters and session detail', async () => {
    const store = new SessionStore({
      cwd: home.cwd,
      sessionDir: '.sessions',
      sessionId: 'server-session'
    })
    store.append({ role: 'user', content: 'server secret prompt' })
    store.appendToolEvent({ type: 'tool_event', phase: 'start', name: 'grep', toolCallId: 'tc1' })

    const auditDir = join(home.root, 'audit')
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(
      join(auditDir, 'audit-2026-06-01.ndjson'),
      [
        JSON.stringify({
          ts: '2026-06-01T00:00:00.000Z',
          seq: 1,
          pid: 1,
          sessionId: 'server-session',
          cwd: home.cwd,
          agent: { kind: 'main' },
          event: 'tool.call',
          payload: { name: 'grep', inputChars: 12 }
        }),
        JSON.stringify({
          ts: '2026-06-01T00:00:01.000Z',
          seq: 2,
          pid: 1,
          sessionId: 'other-session',
          cwd: home.cwd,
          agent: { kind: 'main' },
          event: 'error',
          payload: { message: 'redacted' }
        })
      ].join('\n') + '\n',
      'utf-8'
    )

    const dashboard = await startDashboardServer({
      cwd: home.cwd,
      sessionDir: '.sessions',
      auditDir,
      host: '127.0.0.1',
      port: 0
    })

    try {
      const html = await fetch(`${dashboard.url}/`).then((response) => response.text())
      expect(html).toContain('q-code Dashboard')

      const snapshot = await fetch(`${dashboard.url}/api/dashboard`).then((response) => response.json()) as any
      expect(snapshot.summary.sessionCount).toBe(1)
      expect(snapshot.audit.recentEvents).toHaveLength(2)
      expect(JSON.stringify(snapshot)).not.toContain(home.root)

      const filtered = await fetch(`${dashboard.url}/api/dashboard?session=server-session&tool=grep`).then(
        (response) => response.json()
      ) as any
      expect(filtered.audit.recentEvents).toHaveLength(1)
      expect(filtered.audit.recentEvents[0].event).toBe('tool.call')

      const detail = await fetch(`${dashboard.url}/api/sessions/server-session`).then((response) => response.json()) as any
      expect(detail.session.sessionId).toBe('server-session')
      expect(detail.messages[0].preview).toContain('[redacted')
      expect(JSON.stringify(detail)).not.toContain('server secret prompt')
      expect(JSON.stringify(detail)).not.toContain(home.root)

      const missing = await fetch(`${dashboard.url}/api/sessions/missing`)
      expect(missing.status).toBe(404)
    } finally {
      await dashboard.close()
    }
  })

  it('rejects non-loopback hosts', async () => {
    await expect(
      startDashboardServer({
        cwd: home.cwd,
        host: '0.0.0.0',
        port: 0
      })
    ).rejects.toThrow(/loopback-only/)
  })
})
