/**
 * 会话内模型用量追踪：逐步记录、累计汇总与 cache 模式管理。
 */
import { computeCost, resolveModelPricing } from './pricing'
import type { CacheMode, NormalizedUsage, UsageCost, UsageRecord, UsageTotals } from './types'

/** 维护当前会话的 `UsageRecord` 列表并计算累计 totals。 */
export class UsageTracker {
  private readonly records: UsageRecord[] = []
  private cacheMode: CacheMode

  /**
   * @param options.cacheMode 初始 cache 模式，默认取最后一条记录或 `auto`
   * @param options.records 预加载的历史记录
   */
  constructor(options: { cacheMode?: CacheMode; records?: UsageRecord[] } = {}) {
    this.records.push(...(options.records ?? []))
    this.cacheMode = options.cacheMode ?? lastRecord(this.records)?.cacheMode ?? 'auto'
  }

  /** 设置后续 `record` 使用的 cache 模式。 */
  setCacheMode(mode: CacheMode): void {
    this.cacheMode = mode
  }

  /** 返回当前 cache 模式。 */
  getCacheMode(): CacheMode {
    return this.cacheMode
  }

  /**
   * 记录一步模型调用用量，并在有定价表时计算成本。
   * @param model 模型名称
   * @param usage 归一化后的 token 用量
   * @param timestamp ISO 时间戳，默认当前时间
   */
  record(model: string, usage: NormalizedUsage, timestamp: string = new Date().toISOString()): UsageRecord {
    const resolved = resolveModelPricing(model)
    const record: UsageRecord = {
      timestamp,
      model,
      usage,
      cacheMode: this.cacheMode,
      ...(resolved ? { pricingModel: resolved.model, cost: computeCost(usage, resolved.pricing) } : {})
    }
    this.records.push(record)
    return record
  }

  /** 追加一条已有记录（如从会话恢复）。 */
  addRecord(record: UsageRecord): void {
    this.records.push(record)
  }

  /** 返回所有记录的浅拷贝列表。 */
  list(): UsageRecord[] {
    return [...this.records]
  }

  /**
   * 汇总全部步骤的 token 与成本；若全部步骤无定价则省略 cost。
   */
  totals(): UsageTotals {
    const usage = emptyUsage()
    let cost: UsageCost | undefined = { cost: 0, baselineCost: 0, savedCost: 0 }
    let unknownCostSteps = 0

    for (const record of this.records) {
      addUsageInto(usage, record.usage)
      if (record.cost) {
        cost!.cost += record.cost.cost
        cost!.baselineCost += record.cost.baselineCost
        cost!.savedCost += record.cost.savedCost
      } else {
        unknownCostSteps++
      }
    }

    if (unknownCostSteps > 0 && unknownCostSteps === this.records.length) cost = undefined
    const cacheEligible = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    const cacheHitRate = cacheEligible > 0 ? usage.cacheReadTokens / cacheEligible : 0

    return {
      steps: this.records.length,
      usage,
      cacheMode: this.cacheMode,
      ...(cost ? { cost } : {}),
      unknownCostSteps,
      cacheHitRate
    }
  }
}

/** 返回全零的 `NormalizedUsage` 对象。 */
export function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0
  }
}

function addUsageInto(target: NormalizedUsage, source: NormalizedUsage): void {
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.totalTokens += source.totalTokens
}

function lastRecord(records: readonly UsageRecord[]): UsageRecord | undefined {
  return records.length > 0 ? records[records.length - 1] : undefined
}
