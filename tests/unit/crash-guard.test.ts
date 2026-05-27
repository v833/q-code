import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCrashGuard } from '../../src/runtime/crash-guard'
import { SessionStore } from '../../src/session/store'
import {
  NdjsonAuditLogger,
  resetAuditLoggerForTests,
  setCrashGuardOwnsSignalHandlers,
  type AuditLogger
} from '../../src/observability/audit'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

describe('crash guard', () => {
  let home: TempHome | undefined

  afterEach(() => {
    resetAuditLoggerForTests()
    setCrashGuardOwnsSignalHandlers(false)
    home?.dispose()
    home = undefined
    vi.restoreAllMocks()
  })

  it('uncaughtException 路径恢复终端、执行清理、写报告并落盘 mid-stream 标记', async () => {
    home = setupTempHome('crash-guard-')
    const store = new SessionStore({ cwd: home.cwd, sessionId: 's1' })
    store.append({ role: 'user', content: 'hello' })
    const reportDir = join(home.root, 'crashes')
    const events: string[] = []
    const stderr: string[] = []
    const reports: Array<{ filePath: string; report: any }> = []
    const exits: number[] = []
    resetAuditLoggerForTests(createAuditStub(events))

    const guard = installCrashGuard({
      register: false,
      sessionStore: store,
      terminal: createTerminalStub(events),
      cleanupHandlers: [
        () => {
          events.push('cleanup:mcp')
        },
        () => {
          events.push('cleanup:agents')
        }
      ],
      reportDir,
      version: '1.2.3',
      now: () => new Date('2026-05-26T01:02:03.000Z'),
      getSnapshot: () => ({
        sessionId: 's1',
        cwd: home!.cwd,
        modelName: 'gpt-test',
        agentMode: 'normal',
        taskMode: 'task',
        activeTurnInFlight: true
      }),
      stderr: {
        write: (chunk) => {
          stderr.push(String(chunk))
          return true
        }
      },
      writeReport: (filePath, report) => reports.push({ filePath, report }),
      exit: (code) => {
        exits.push(code)
      }
    })

    guard.handleUncaughtException(new Error('boom'))

    await vi.waitFor(() => expect(exits).toEqual([1]))
    expect(events).toEqual([
      'terminal:unmount',
      'terminal:wait',
      'cleanup:mcp',
      'cleanup:agents',
      'audit:error',
      'audit:flush'
    ])
    expect(stderr.join('')).toContain('\u001b[?25h\u001b[?1049l\u001b[0m')
    expect(stderr.join('')).toContain('q-code 异常退出')
    expect(stderr.join('')).toContain('q-code audit tail')
    expect(reports[0]?.filePath).toBe(join(reportDir, 'crash-s1-20260526T010203Z.json'))
    expect(reports[0]?.report).toMatchObject({
      version: '1.2.3',
      sessionId: 's1',
      modelName: 'gpt-test',
      error: { message: 'boom' }
    })
    expect(store.load().at(-1)).toEqual({
      role: 'assistant',
      content: '[crashed mid-stream]'
    })
  })

  it('unhandledRejection 路径同样写崩溃报告', async () => {
    home = setupTempHome('crash-guard-rejection-')
    const reports: Array<{ report: any }> = []
    const exits: number[] = []
    resetAuditLoggerForTests(createAuditStub([]))

    const guard = installCrashGuard({
      register: false,
      cleanupHandlers: [],
      reportDir: join(home.root, 'crashes'),
      now: () => new Date('2026-05-26T01:02:03.000Z'),
      getSnapshot: () => ({ sessionId: 's2', cwd: home!.cwd }),
      stderr: { write: () => true },
      writeReport: (_filePath, report) => reports.push({ report }),
      exit: (code) => {
        exits.push(code)
      }
    })

    guard.handleUnhandledRejection(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))

    await vi.waitFor(() => expect(exits).toEqual([1]))
    expect(reports[0]?.report.error).toMatchObject({
      message: 'socket hang up',
      code: 'ECONNRESET'
    })
  })

  it('崩溃标记写入崩溃瞬间的当前会话', async () => {
    home = setupTempHome('crash-guard-active-session-')
    const firstStore = new SessionStore({ cwd: home.cwd, sessionId: 'first' })
    const activeStore = new SessionStore({ cwd: home.cwd, sessionId: 'active' })
    let currentStore = firstStore
    const exits: number[] = []
    resetAuditLoggerForTests(createAuditStub([]))

    const guard = installCrashGuard({
      register: false,
      sessionStore: firstStore,
      getSessionStore: () => currentStore,
      cleanupHandlers: [],
      reportDir: join(home.root, 'crashes'),
      getSnapshot: () => ({
        sessionId: currentStore.sessionId,
        cwd: home!.cwd,
        activeTurnInFlight: true
      }),
      stderr: { write: () => true },
      exit: (code) => {
        exits.push(code)
      }
    })

    currentStore = activeStore
    guard.handleUncaughtException(new Error('boom'))

    await vi.waitFor(() => expect(exits).toEqual([1]))
    expect(firstStore.load()).toEqual([])
    expect(activeStore.load().at(-1)).toEqual({
      role: 'assistant',
      content: '[crashed mid-stream]'
    })
  })

  it('快照采集失败时仍写出原始崩溃报告', async () => {
    home = setupTempHome('crash-guard-snapshot-error-')
    const reports: Array<{ report: any }> = []
    const exits: number[] = []
    resetAuditLoggerForTests(createAuditStub([]))

    const guard = installCrashGuard({
      register: false,
      cleanupHandlers: [],
      reportDir: join(home.root, 'crashes'),
      now: () => new Date('2026-05-26T01:02:03.000Z'),
      getSnapshot: () => {
        throw new Error('snapshot failed')
      },
      stderr: { write: () => true },
      writeReport: (_filePath, report) => reports.push({ report }),
      exit: (code) => {
        exits.push(code)
      }
    })

    guard.handleUncaughtException(new Error('boom'))

    await vi.waitFor(() => expect(exits).toEqual([1]))
    expect(reports[0]?.report.error).toMatchObject({ message: 'boom' })
    expect(reports[0]?.report.snapshotError).toMatchObject({ message: 'snapshot failed' })
  })

  it('只采集一次 cleanup 前快照，保留崩溃现场状态', async () => {
    home = setupTempHome('crash-guard-single-snapshot-')
    const reports: Array<{ report: any }> = []
    const exits: number[] = []
    let snapshotCalls = 0
    let asyncAgents = [{ agentId: 'a1', status: 'running' }]
    resetAuditLoggerForTests(createAuditStub([]))

    const guard = installCrashGuard({
      register: false,
      cleanupHandlers: [
        () => {
          asyncAgents = []
        }
      ],
      reportDir: join(home.root, 'crashes'),
      getSnapshot: () => {
        snapshotCalls++
        return { asyncAgents: asyncAgents.map((agent) => ({ ...agent })) }
      },
      stderr: { write: () => true },
      writeReport: (_filePath, report) => reports.push({ report }),
      exit: (code) => {
        exits.push(code)
      }
    })

    guard.handleUncaughtException(new Error('boom'))

    await vi.waitFor(() => expect(exits).toEqual([1]))
    expect(snapshotCalls).toBe(1)
    expect(reports[0]?.report.asyncAgents).toEqual([{ agentId: 'a1', status: 'running' }])
  })

  it('注册 crash guard 时会接管并移除 audit signal handlers', () => {
    home = setupTempHome('crash-guard-signal-owner-')
    const once = vi.spyOn(process, 'once').mockReturnValue(process)
    const on = vi.spyOn(process, 'on').mockReturnValue(process)
    const off = vi.spyOn(process, 'off').mockReturnValue(process)

    new NdjsonAuditLogger({
      auditDir: join(home.root, 'audit')
    })
    expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(once).toHaveBeenCalledWith('SIGTERM', expect.any(Function))

    const guard = installCrashGuard({
      cleanupHandlers: [],
      reportDir: join(home.root, 'crashes')
    })

    expect(off).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(off).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
    expect(on).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
    guard.dispose()
  })

  it('SIGINT 第二次触发立即强制退出', async () => {
    home = setupTempHome('crash-guard-signal-')
    mkdirSync(join(home.root, 'crashes'), { recursive: true })
    const exits: number[] = []
    const cleanup = createDeferred<void>()
    resetAuditLoggerForTests(createAuditStub([]))

    const guard = installCrashGuard({
      register: false,
      cleanupHandlers: [() => cleanup.promise],
      reportDir: join(home.root, 'crashes'),
      cleanupTimeoutMs: 10,
      stderr: { write: () => true },
      exit: (code) => {
        exits.push(code)
      }
    })

    guard.handleSignal('SIGINT')
    guard.handleSignal('SIGINT')

    expect(exits).toEqual([130])
    cleanup.resolve()
    await vi.waitFor(() => expect(exits).toEqual([130, 130]))
  })
})

function createAuditStub(events: string[]): AuditLogger {
  return {
    emit: (event) => {
      events.push(`audit:${event}`)
    },
    flush: async () => {
      events.push('audit:flush')
    }
  }
}

function createTerminalStub(events: string[]): any {
  return {
    instance: {
      unmount: () => events.push('terminal:unmount'),
      waitUntilExit: async () => {
        events.push('terminal:wait')
      }
    }
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
