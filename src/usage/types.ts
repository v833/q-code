/**
 * Usage 统计相关的类型定义：归一化用量、定价、成本与会话汇总。
 */

/** 显式 cache hints 模式：自动 / 强制开启 / 关闭。 */
export type CacheMode = 'auto' | 'on' | 'off'

/** 跨供应商统一后的 token 用量结构。 */
export interface NormalizedUsage {
  /** 非 cache 的输入 token。 */
  inputTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 从 cache 读取的输入 token。 */
  cacheReadTokens: number
  /** 写入 cache 的输入 token。 */
  cacheWriteTokens: number
  /** 四类 token 之和。 */
  totalTokens: number
}

/** 每百万 token 的美元单价（input/output/cache 分项）。 */
export interface ModelPricing {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** 单次调用的实际成本、无 cache 基线与节省额。 */
export interface UsageCost {
  cost: number
  baselineCost: number
  savedCost: number
}

/** 单步模型调用的用量记录（可含成本）。 */
export interface UsageRecord {
  timestamp: string
  model: string
  usage: NormalizedUsage
  cacheMode: CacheMode
  cost?: UsageCost
  /** 命中价格表时使用的定价键名。 */
  pricingModel?: string
}

/** 会话内多步调用的累计用量与成本汇总。 */
export interface UsageTotals {
  steps: number
  usage: NormalizedUsage
  cacheMode: CacheMode
  cost?: UsageCost
  /** 缺少定价表的步骤数。 */
  unknownCostSteps: number
  /** cache 读取占可 cache 输入的比例。 */
  cacheHitRate: number
}
