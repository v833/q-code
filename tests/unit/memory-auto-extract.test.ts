import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { extractExplicitMemoryCandidate } from '../../src/context/memory/auto-extract'

describe('memory auto extract', () => {
  it('extracts only explicit remember requests from recent user turns', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '普通问题，不要保存' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '请记住：以后回答我时优先用中文说明取舍。' }
    ]

    const candidate = extractExplicitMemoryCandidate(messages, new Date('2026-06-02T00:00:00.000Z'))

    expect(candidate).toMatchObject({
      description: '用户显式要求长期记住的信息',
      type: 'feedback'
    })
    expect(candidate?.content).toContain('以后回答我时优先用中文说明取舍')
    expect(candidate?.content).toContain('2026-06-02T00:00:00.000Z')
  })

  it('returns null for implicit chatter and ignore-memory turns', () => {
    expect(extractExplicitMemoryCandidate([{ role: 'user', content: '我喜欢这个方案' }])).toBeNull()
    expect(extractExplicitMemoryCandidate([{ role: 'user', content: '忽略记忆，请记住：不要保存这个' }])).toBeNull()
  })
})
