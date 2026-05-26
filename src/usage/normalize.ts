/**
 * 将各供应商/API 的 usage 对象归一化为统一的 `NormalizedUsage`。
 */
import type { TokenUsage } from '../context/token-budget'
import type { NormalizedUsage } from './types'

/**
 * 从任意 usage 形状提取 input/output/cache 分项；兼容 AI SDK 与多供应商字段名。
 * @param usage 原始 usage 对象或 undefined
 */
export function normalizeUsage(usage: unknown): NormalizedUsage {
  const record = isRecord(usage) ? usage : {}
  const cacheReadTokens = firstNumber(
    record,
    'cacheReadTokens',
    'cachedInputTokens',
    'cachedTokens',
    'cache_read_input_tokens',
    'cacheReadInputTokens'
  )
  const cacheWriteTokens = firstNumber(
    record,
    'cacheWriteTokens',
    'cacheCreationInputTokens',
    'cache_creation_input_tokens'
  )
  const providerMetadata = isRecord(record.providerMetadata) ? record.providerMetadata : {}
  const inputTokenDetails = isRecord(record.inputTokenDetails) ? record.inputTokenDetails : {}
  const detailsNoCache = firstNumber(inputTokenDetails, 'noCacheTokens', 'noCache')
  const detailsCacheRead = firstNumber(inputTokenDetails, 'cacheReadTokens', 'cacheRead')
  const detailsCacheWrite = firstNumber(inputTokenDetails, 'cacheWriteTokens', 'cacheWrite')
  const metadataCacheRead = firstDeepNumber(providerMetadata, [
    ['openai', 'cachedTokens'],
    ['openai', 'cachedInputTokens'],
    ['openai', 'promptTokensDetails', 'cachedTokens'],
    ['openai', 'prompt_tokens_details', 'cached_tokens'],
    ['deepseek', 'cachedTokens'],
    ['deepseek', 'cachedInputTokens'],
    ['qwen', 'cachedTokens'],
    ['qwen', 'cachedInputTokens']
  ])
  const metadataCacheWrite = firstDeepNumber(providerMetadata, [
    ['anthropic', 'cacheCreationInputTokens'],
    ['anthropic', 'cache_creation_input_tokens'],
    ['qwen', 'cacheCreationInputTokens'],
    ['qwen', 'cache_creation_input_tokens']
  ])

  const cacheRead = Math.max(0, cacheReadTokens ?? detailsCacheRead ?? metadataCacheRead ?? 0)
  const cacheWrite = Math.max(0, cacheWriteTokens ?? detailsCacheWrite ?? metadataCacheWrite ?? 0)
  const rawInput = Math.max(0, firstNumber(record, 'inputTokens', 'promptTokens') ?? 0)
  const output = Math.max(0, firstNumber(record, 'outputTokens', 'completionTokens') ?? 0)
  const shouldSubtractCacheWrite = cacheWriteTokens !== undefined || detailsCacheWrite !== undefined
  const input =
    detailsNoCache !== undefined
      ? Math.max(0, detailsNoCache)
      : Math.max(
          0,
          rawInput - Math.min(rawInput, cacheRead + (shouldSubtractCacheWrite ? cacheWrite : 0))
        )

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite
  }
}

/** 将 `TokenUsage` 转为 `NormalizedUsage`（cache 字段置零）。 */
export function normalizeTokenUsage(usage: TokenUsage | undefined): NormalizedUsage {
  return normalizeUsage(usage)
}

/** 快捷读取归一化后的 cache 读取 token 数。 */
export function readCacheReadTokens(usage: unknown): number {
  return normalizeUsage(usage).cacheReadTokens
}

/** 快捷读取归一化后的 cache 写入 token 数。 */
export function readCacheWriteTokens(usage: unknown): number {
  return normalizeUsage(usage).cacheWriteTokens
}

function firstNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function firstDeepNumber(
  record: Record<string, unknown>,
  paths: string[][]
): number | undefined {
  for (const path of paths) {
    let current: unknown = record
    for (const segment of path) {
      if (!isRecord(current)) {
        current = undefined
        break
      }
      current = current[segment]
    }
    if (typeof current === 'number' && Number.isFinite(current)) return current
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
