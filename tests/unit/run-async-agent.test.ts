import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAllAsyncAgents,
  registerAsyncAgent
} from '../../src/agents/async-agent-store'
import {
  clearPendingNotifications,
  drainPendingNotifications
} from '../../src/agents/notification-store'
import { runAsyncAgentLifecycle } from '../../src/agents/run-async-agent'
import { ensureTaskOutputFile } from '../../src/agents/task-output'
import type { AgentDefinition } from '../../src/agents/types'
import { createMockModel } from '../_helpers/mock-model'

describe('runAsyncAgentLifecycle final output', () => {
  const tempDirs: string[] = []
  const originalSessionDir = process.env.Q_CODE_SESSION_DIR

  afterEach(() => {
    if (originalSessionDir === undefined) delete process.env.Q_CODE_SESSION_DIR
    else process.env.Q_CODE_SESSION_DIR = originalSessionDir
    clearAllAsyncAgents()
    clearPendingNotifications()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not inline long finalText in completed task notifications', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-async-agent-'))
    tempDirs.push(cwd)
    process.env.Q_CODE_SESSION_DIR = '.sessions'
    const outputFile = await ensureTaskOutputFile({
      cwd,
      sessionId: 'session-1',
      agentId: 'agent-1'
    })
    const entry = registerAsyncAgent({
      agentId: 'agent-1',
      agentType: 'Explore',
      description: 'scan',
      prompt: 'scan',
      outputFile,
      cwd,
      sessionId: 'session-1'
    })
    const finalText = `BEGIN\n${'Y'.repeat(9000)}\nEND`
    const { model } = createMockModel([{ text: finalText, finishReason: 'stop' }])

    await runAsyncAgentLifecycle({
      entry,
      agentDefinition: makeAgentDefinition(),
      prompt: 'scan',
      availableTools: [],
      model,
      sessionId: 'session-1'
    })

    const notification = drainPendingNotifications()[0]?.text ?? ''
    expect(notification).toContain('<task-notification>')
    expect(notification).toContain('<result_preview>')
    expect(notification).toContain('<result_truncated>true</result_truncated>')
    expect(notification).toContain('<artifact_file>')
    expect(notification).not.toContain('Y'.repeat(8000))
    const artifactFile = extractTag(notification, 'artifact_file')
    expect(artifactFile).toBeTruthy()
    expect(readFileSync(artifactFile!, 'utf8')).toBe(finalText)
  })
})

function makeAgentDefinition(): AgentDefinition {
  return {
    agentType: 'Explore',
    whenToUse: 'test',
    source: 'built-in',
    getSystemPrompt: () => 'sys'
  }
}

function extractTag(text: string, tag: string): string | undefined {
  const start = `<${tag}>`
  const end = `</${tag}>`
  const startIndex = text.indexOf(start)
  const endIndex = text.indexOf(end)
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return undefined
  return text.slice(startIndex + start.length, endIndex)
}
