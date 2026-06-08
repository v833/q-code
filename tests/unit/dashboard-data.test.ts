import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendTaskOutput, ensureTaskOutputFile } from '../../src/agents/task-output'
import { blockTask, createTask } from '../../src/context/tasks'
import { collectDashboardData, collectDashboardSessionDetail } from '../../src/dashboard/data'
import { SessionStore } from '../../src/session/store'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

describe('dashboard data', () => {
  let home: TempHome

  beforeEach(() => {
    home = setupTempHome('dashboard-data-')
  })

  afterEach(() => {
    home.dispose()
  })

  it('collects local artifacts and keeps sensitive text redacted', async () => {
    const store = new SessionStore({
      cwd: home.cwd,
      sessionDir: '.sessions',
      sessionId: 'dash-session'
    })
    store.updateMetadata({ displayName: 'Dashboard Demo', model: 'test-model' })
    store.append({ role: 'user', content: 'secret prompt should not leak' })
    store.append({ role: 'assistant', content: 'hidden answer should not leak' })
    store.appendToolEvent({ type: 'tool_event', phase: 'start', name: 'read_file', toolCallId: 'tc1' })
    store.appendToolEvent({
      type: 'tool_event',
      phase: 'done',
      name: 'read_file',
      toolCallId: 'tc1',
      resultLength: 120,
      isError: false
    })
    store.appendUsageV2(
      {
        timestamp: '2026-06-01T00:00:00.000Z',
        model: 'test-model',
        cacheMode: 'auto',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 18
        },
        cost: {
          cost: 0.001,
          baselineCost: 0.002,
          savedCost: 0.001
        },
        pricingModel: 'test-model'
      },
      {
        steps: 1,
        cacheMode: 'auto',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 18
        },
        cost: {
          cost: 0.001,
          baselineCost: 0.002,
          savedCost: 0.001
        },
        unknownCostSteps: 0,
        cacheHitRate: 0.2
      }
    )

    const auditDir = join(home.root, 'audit')
    mkdirSync(auditDir, { recursive: true })
    writeFileSync(
      join(auditDir, 'audit-2026-06-01.ndjson'),
      [
        JSON.stringify({
          ts: '2026-06-01T00:00:00.000Z',
          seq: 1,
          pid: 1,
          sessionId: 'dash-session',
          cwd: home.cwd,
          agent: { kind: 'main' },
          event: 'tool.call',
          payload: { name: 'read_file', inputChars: 999, input: 'raw secret' }
        }),
        JSON.stringify({
          ts: '2026-06-01T00:00:01.000Z',
          seq: 2,
          pid: 1,
          sessionId: 'dash-session',
          cwd: home.cwd,
          agent: { kind: 'main' },
          event: 'tool.result',
          payload: { name: 'read_file', ok: true, resultLength: 120, output: 'raw output' }
        })
      ].join('\n') + '\n',
      'utf-8'
    )

    const taskOne = await createTask({ cwd: home.cwd, sessionId: 'dash-session' }, {
      subject: 'inspect secret task',
      description: 'details stay local'
    })
    const taskTwo = await createTask({ cwd: home.cwd, sessionId: 'dash-session' }, {
      subject: 'finish dashboard',
      description: 'done criteria'
    })
    await blockTask({ cwd: home.cwd, sessionId: 'dash-session' }, taskOne.id, taskTwo.id)

    const outputPath = await ensureTaskOutputFile({
      cwd: home.cwd,
      sessionId: 'dash-session',
      agentId: 'agent-1'
    })
    await appendTaskOutput(outputPath, {
      type: 'started',
      agentType: 'reviewer',
      prompt: 'agent prompt should not leak',
      description: 'review secret branch'
    })
    await appendTaskOutput(outputPath, { type: 'tool_use', toolName: 'grep' })
    await appendTaskOutput(outputPath, {
      type: 'completed',
      finalText: 'final secret should not leak',
      durationMs: 100,
      totalTokens: 42,
      toolUseCount: 1
    })

    const runDir = join(home.cwd, '.q-code', 'evals', 'runs', 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        summary: {
          runId: 'run-1',
          suiteName: 'smoke',
          cwd: home.cwd,
          sources: [],
          startedAt: '2026-06-01T00:00:00.000Z',
          finishedAt: '2026-06-01T00:00:02.000Z',
          durationMs: 2000,
          caseCount: 1,
          selectedCaseCount: 1,
          resultCount: 1,
          repeat: 1,
          passed: 1,
          failed: 0,
          passRate: 1,
          passAt1: 1,
          passPowK: {},
          averageScore: 1,
          averageProgressRate: 1,
          totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          unknownCostCases: 0,
          outputDir: runDir,
          concurrency: 1,
          reportFormats: ['json']
        },
        results: []
      }),
      'utf-8'
    )

    const snapshot = collectDashboardData({
      cwd: home.cwd,
      sessionDir: '.sessions',
      auditDir
    })

    expect(snapshot.summary.sessionCount).toBe(1)
    expect(snapshot.summary.auditEventCount).toBe(2)
    expect(snapshot.summary.taskCount).toBe(2)
    expect(snapshot.summary.agentArtifactCount).toBe(1)
    expect(snapshot.summary.evalRunCount).toBe(1)
    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: 'dash-session',
      toolCallCount: 1,
      totalTokens: 18
    })
    expect(snapshot.sessions[0]?.lastUserPromptDigest).toContain('[redacted')
    expect(JSON.stringify(snapshot)).not.toContain('secret prompt should not leak')
    expect(JSON.stringify(snapshot)).not.toContain('raw secret')
    expect(snapshot.audit.byTool.read_file).toBe(2)
    expect(snapshot.tasks.edges).toContainEqual({
      sessionId: 'dash-session',
      from: taskOne.id,
      to: taskTwo.id
    })
    expect(snapshot.agents.artifacts[0]).toMatchObject({
      sessionId: 'dash-session',
      agentType: 'reviewer',
      status: 'completed',
      toolUseCount: 1,
      totalTokens: 42
    })
    expect(snapshot.evals.runs[0]).toMatchObject({
      runId: 'run-1',
      passRate: 1
    })
    expect(snapshot.sessions[0]?.transcriptPath).not.toContain(home.root)
    expect(snapshot.agents.artifacts[0]?.outputPath).not.toContain(home.root)
    expect(snapshot.evals.runs[0]?.outputDir).not.toContain(home.root)
    expect(JSON.stringify(snapshot.dataSources)).not.toContain(home.root)

    const detail = collectDashboardSessionDetail('dash-session', {
      cwd: home.cwd,
      sessionDir: '.sessions'
    })
    expect(detail?.messages).toHaveLength(2)
    expect(detail?.messages[0]?.preview).toContain('[redacted')
    expect(JSON.stringify(detail)).not.toContain('hidden answer should not leak')
    expect(JSON.stringify(detail)).not.toContain(home.root)
    expect(detail?.tools).toHaveLength(2)
    expect(detail?.usageRecords[0]?.usage.totalTokens).toBe(18)
  })
})
