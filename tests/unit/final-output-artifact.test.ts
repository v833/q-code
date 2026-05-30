import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBoundedText,
  createFinalOutputReference,
  getFinalOutputArtifactPath
} from '../../src/agents/final-output-artifact'

describe('SubAgent final output artifact', () => {
  const tempDirs: string[] = []
  const originalSessionDir = process.env.Q_CODE_SESSION_DIR

  afterEach(() => {
    if (originalSessionDir === undefined) delete process.env.Q_CODE_SESSION_DIR
    else process.env.Q_CODE_SESSION_DIR = originalSessionDir
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps short final output inline', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-final-output-'))
    tempDirs.push(cwd)

    const ref = await createFinalOutputReference({
      cwd,
      sessionId: 'session-1',
      agentId: 'agent-1',
      finalText: 'short result',
      inlineCharLimit: 20
    })

    expect(ref).toMatchObject({
      inlineText: 'short result',
      preview: 'short result',
      originalChars: 12,
      resultTruncated: false
    })
    expect(ref.artifactFile).toBeUndefined()
  })

  it('writes long final output to an artifact file with preview metadata', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-final-output-'))
    tempDirs.push(cwd)
    const finalText = `HEAD\n${'A'.repeat(120)}\nTAIL`

    const ref = await createFinalOutputReference({
      cwd,
      sessionId: 'session-1',
      agentId: 'agent-1',
      finalText,
      inlineCharLimit: 20,
      previewCharLimit: 40
    })

    expect(ref.inlineText).toBeUndefined()
    expect(ref.resultTruncated).toBe(true)
    expect(ref.originalChars).toBe(finalText.length)
    expect(ref.artifactFile).toContain('agent-artifacts')
    expect(ref.recoveryHint).toContain('read_file')
    expect(ref.preview).toContain('HEAD')
    expect(ref.preview).toContain('TAIL')
    expect(ref.preview).not.toContain('A'.repeat(80))
    expect(existsSync(ref.artifactFile!)).toBe(true)
    expect(readFileSync(ref.artifactFile!, 'utf8')).toBe(finalText)
  })

  it('falls back to preview metadata when artifact write fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-final-output-'))
    tempDirs.push(cwd)
    process.env.Q_CODE_SESSION_DIR = '.sessions'
    const artifactFile = getFinalOutputArtifactPath({
      cwd,
      sessionId: 'session-1',
      agentId: 'agent-1'
    })
    const artifactRoot = dirname(dirname(artifactFile))
    mkdirSync(dirname(artifactRoot), { recursive: true })
    writeFileSync(artifactRoot, 'not a directory')
    const finalText = `HEAD\n${'A'.repeat(120)}\nTAIL`

    const ref = await createFinalOutputReference({
      cwd,
      sessionId: 'session-1',
      agentId: 'agent-1',
      finalText,
      inlineCharLimit: 20,
      previewCharLimit: 40,
      fallbackFile: '/tmp/agent.output'
    })

    expect(ref.inlineText).toBeUndefined()
    expect(ref.artifactFile).toBeUndefined()
    expect(ref.resultTruncated).toBe(true)
    expect(ref.recoveryHint).toContain('artifact 写入失败')
    expect(ref.recoveryHint).toContain('/tmp/agent.output')
    expect(ref.preview).toContain('HEAD')
    expect(ref.preview).toContain('TAIL')
  })

  it('bounds error text while retaining original length metadata', () => {
    const bounded = createBoundedText('E'.repeat(25), 10)

    expect(bounded.truncated).toBe(true)
    expect(bounded.originalChars).toBe(25)
    expect(bounded.text).toContain('truncated 15 chars')
    expect(bounded.text.length).toBeLessThan(60)
  })
})
