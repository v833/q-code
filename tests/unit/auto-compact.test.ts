import { describe, expect, it } from 'vitest'
import { CompactionCircuitBreaker } from '../../src/context/auto-compact'
import type { TokenBudgetSnapshot } from '../../src/context/token-budget'

describe('CompactionCircuitBreaker', () => {
  it('resets failure count after an explicit session switch reset', () => {
    const breaker = new CompactionCircuitBreaker(2)
    breaker.recordFailure()
    breaker.recordFailure()

    expect(breaker.isOpen).toBe(true)
    expect(breaker.shouldAttempt(snapshot('blocking'))).toBe(false)

    breaker.reset()

    expect(breaker.failures).toBe(0)
    expect(breaker.isOpen).toBe(false)
    expect(breaker.shouldAttempt(snapshot('blocking'))).toBe(true)
  })
})

function snapshot(state: TokenBudgetSnapshot['state']): TokenBudgetSnapshot {
  return {
    used: 100,
    limit: 100,
    effectiveLimit: 100,
    compactThreshold: 80,
    warningThreshold: 70,
    blockingThreshold: 95,
    ratio: 1,
    state
  }
}
