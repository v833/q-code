import { describe, expect, it } from 'vitest'
import {
  createLangfuseSummaryPayload,
  getLangfuseConfig
} from '../../src/observability/langfuse'

describe('langfuse observability', () => {
  it('is disabled by default and keeps IO recording off', () => {
    const config = getLangfuseConfig({})

    expect(config.enabled).toBe(false)
    expect(config.recordIO).toBe(false)
    expect(config.baseUrl).toBe('https://cloud.langfuse.com')
    expect(config.sampleRate).toBe(1)
  })

  it('summarizes values without exposing raw content', () => {
    const summary = createLangfuseSummaryPayload({
      prompt: 'secret prompt',
      nested: { output: 'secret output' }
    })

    expect(summary).toMatchObject({ chars: expect.any(Number), sha256: expect.any(String) })
    expect(JSON.stringify(summary)).not.toContain('secret prompt')
    expect(JSON.stringify(summary)).not.toContain('secret output')
    expect(summary).not.toHaveProperty('preview')
  })
})
