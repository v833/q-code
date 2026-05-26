/**
 * 模型定价表与成本计算：按百万 token 美元单价估算实际/基线/节省成本。
 */
import type { ModelPricing, NormalizedUsage, UsageCost } from './types'

/** 内置模型名（小写）到单价的默认价格表。 */
export const DEFAULT_PRICE_TABLE: Record<string, ModelPricing> = {
  'gpt-5': { input: 5, output: 15, cacheWrite: 5, cacheRead: 1.25 },
  'gpt-5.4': { input: 5, output: 15, cacheWrite: 5, cacheRead: 1.25 },
  'gpt-5.5': { input: 5, output: 15, cacheWrite: 5, cacheRead: 0.5 },
  'claude-sonnet-4-7': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'deepseek-v3-2': { input: 0.27, output: 1.1, cacheWrite: 0.27, cacheRead: 0.027 },
  'qwen3-6-plus': { input: 0.4, output: 1.2, cacheWrite: 0.4, cacheRead: 0.04 },
  'mock-model': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
}

/**
 * 解析模型对应的定价；先精确匹配，再最长前缀匹配。
 * @param model 模型名称
 * @param table 价格表，默认 `DEFAULT_PRICE_TABLE`
 */
export function resolveModelPricing(
  model: string,
  table: Record<string, ModelPricing> = DEFAULT_PRICE_TABLE
): { model: string; pricing: ModelPricing } | undefined {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return undefined
  const exact = table[normalized]
  if (exact) return { model: normalized, pricing: exact }

  const matched = Object.keys(table)
    .filter((key) => normalized.startsWith(key))
    .sort((a, b) => b.length - a.length)[0]
  return matched ? { model: matched, pricing: table[matched]! } : undefined
}

/**
 * 根据归一化用量与单价计算成本；无定价时返回 undefined。
 * baseline 假设全部输入按 input 单价计费，saved 为 baseline 与实际之差。
 */
export function computeCost(
  usage: NormalizedUsage,
  pricing: ModelPricing | undefined
): UsageCost | undefined {
  if (!pricing) return undefined
  const inputCost = priceTokens(usage.inputTokens, pricing.input)
  const outputCost = priceTokens(usage.outputTokens, pricing.output)
  const cacheReadCost = priceTokens(usage.cacheReadTokens, pricing.cacheRead)
  const cacheWriteCost = priceTokens(usage.cacheWriteTokens, pricing.cacheWrite)
  const cost = inputCost + outputCost + cacheReadCost + cacheWriteCost
  const baselineCost =
    priceTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, pricing.input) +
    outputCost
  return {
    cost,
    baselineCost,
    savedCost: Math.max(0, baselineCost - cost)
  }
}

function priceTokens(tokens: number, dollarsPerMillion: number): number {
  return (Math.max(0, tokens) / 1_000_000) * dollarsPerMillion
}
