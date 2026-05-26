/**
 * Agent Loop 与模型请求的可重试错误判定与退避策略。
 *
 * 供 `loop.ts` 在 stream 消费失败时决定是否重试整步，以及重试间隔。
 */

/**
 * 判断错误是否值得在 Agent 步骤级重试。
 *
 * 可重试：429/529/408、5xx、常见网络错误、AI SDK 的 NoOutputGeneratedError。
 * 4xx（除上述特例）视为客户端错误，不重试。
 *
 * @param error - 捕获的异常（通常为 `Error`）
 * @returns 是否应触发退避重试
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const message = error.message || ''

  // HTTP 状态码判断
  const statusMatch = message.match(/(\d{3})/)
  if (statusMatch) {
    const status = parseInt(statusMatch[1])
    if ([429, 529, 408].includes(status)) return true
    if (status >= 500 && status < 600) return true
    if (status >= 400 && status < 500) return false
  }

  // 网络错误
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true
  if (message.includes('fetch failed') || message.includes('network')) return true
  // AI SDK 会把流式错误包装成 NoOutputGeneratedError
  if (message.includes('No output generated')) return true

  return false
}

/**
 * 计算第 N 次重试的等待毫秒数（指数退避 + ±25% 抖动）。
 *
 * @param attempt - 从 1 开始的尝试序号
 * @param baseMs - 首次退避基数，默认 500ms
 * @param maxMs - 退避上限，默认 30000ms
 * @returns 非负整数毫秒
 */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, maxMs)
  const jitterRange = capped * 0.25
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange
  return Math.max(0, Math.round(jittered))
}

/**
 * 异步等待指定毫秒（重试间隔用）。
 *
 * @param ms - 等待时长
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
