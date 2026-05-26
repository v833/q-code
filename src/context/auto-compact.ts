/**
 * 自动上下文压缩熔断器：连续失败达到上限后暂停自动压缩尝试。
 */
import type { TokenBudgetSnapshot } from './token-budget'

/** 跟踪连续压缩失败次数，达到阈值后打开熔断。 */
export class CompactionCircuitBreaker {
  private consecutiveFailures = 0

  /**
   * @param maxFailures 连续失败多少次后打开熔断，默认 3
   */
  constructor(private readonly maxFailures = 3) {}

  /** 当前连续失败次数。 */
  get failures(): number {
    return this.consecutiveFailures
  }

  /** 熔断是否已打开（不再尝试自动压缩）。 */
  get isOpen(): boolean {
    return this.consecutiveFailures >= this.maxFailures
  }

  /**
   * 根据 token 预算快照判断是否应尝试压缩。
   * @param snapshot 当前上下文 token 预算快照
   * @returns 未熔断且状态为 error 或 blocking 时返回 true
   */
  shouldAttempt(snapshot: TokenBudgetSnapshot): boolean {
    if (this.isOpen) return false
    return snapshot.state === 'error' || snapshot.state === 'blocking'
  }

  /** 记录一次压缩成功，重置连续失败计数。 */
  recordSuccess(): void {
    this.consecutiveFailures = 0
  }

  /** 记录一次压缩失败，递增连续失败计数。 */
  recordFailure(): void {
    this.consecutiveFailures++
  }
}
