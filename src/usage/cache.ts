/**
 * Prompt cache 前缀追踪与 `/cache` 状态渲染：检测 system/tools 前缀是否稳定。
 */
import { createHash } from 'node:crypto'
import type { ToolDefinition } from '../tools/registry'
import type { CacheMode, UsageTotals } from './types'

/** 单次请求前 system prompt 与工具 schema 的前缀指纹。 */
export interface CachePrefixSnapshot {
  systemHash: string
  toolsHash: string
  toolCount: number
  activeToolSchemaTokens: number
}

/** 当前与前缀快照及变化统计。 */
export interface CachePrefixStatus {
  current?: CachePrefixSnapshot
  previous?: CachePrefixSnapshot
  stable: boolean
  changes: number
}

/** 跨轮观察 system/tools 前缀变化，用于判断是否适合启用显式 cache hints。 */
export class CachePrefixTracker {
  private current?: CachePrefixSnapshot
  private previous?: CachePrefixSnapshot
  private changes = 0
  private stable = true

  /**
   * 记录一次前缀快照；与上次不同时递增 changes 并标记 unstable。
   * @param snapshot 当前 system/tools 指纹
   */
  observe(snapshot: CachePrefixSnapshot): CachePrefixStatus {
    const changed = this.current !== undefined && !samePrefix(this.current, snapshot)
    if (changed) {
      this.previous = this.current
      this.changes++
    }
    this.stable = !changed
    this.current = snapshot
    return this.status()
  }

  /** 返回当前追踪状态（不更新快照）。 */
  status(): CachePrefixStatus {
    return {
      ...(this.current ? { current: this.current } : {}),
      ...(this.previous ? { previous: this.previous } : {}),
      stable: this.stable,
      changes: this.changes
    }
  }
}

/**
 * 解析 slash/CLI 传入的 cache 模式参数。
 * @returns 合法模式或 undefined
 */
export function parseCacheModeArg(value: string): CacheMode | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'auto' || normalized === 'on' || normalized === 'off') return normalized
  return undefined
}

/**
 * 根据 system prompt 与工具列表生成可比较的前缀快照。
 */
export function createCachePrefixSnapshot(input: {
  systemPrompt: string
  tools: readonly ToolDefinition[]
  activeToolSchemaTokens: number
}): CachePrefixSnapshot {
  return {
    systemHash: hashText(input.systemPrompt),
    toolsHash: hashText(
      JSON.stringify(
        input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }))
      )
    ),
    toolCount: input.tools.length,
    activeToolSchemaTokens: input.activeToolSchemaTokens
  }
}

/** 渲染 Cache Status 多行文本（模式、命中率、前缀稳定性）。 */
export function renderCacheStatus(params: {
  mode: CacheMode
  totals: UsageTotals
  prefix: CachePrefixStatus
}): string {
  const lines = ['Cache Status', '', `模式: ${params.mode}`]
  if (params.mode === 'off') {
    lines.push('说明: q-code 显式 cache hints 已关闭；供应商隐式 cache 仍可能命中并上报。')
  } else if (params.mode === 'auto') {
    lines.push('说明: q-code 会追踪供应商 cache 用量，并只在安全时启用显式 cache hints。')
  } else {
    lines.push('说明: 仅对安全支持显式 cache 的供应商启用 cache hints。')
  }

  lines.push('')
  lines.push(`模型步骤: ${params.totals.steps}`)
  lines.push(`Cache 读取: ${params.totals.usage.cacheReadTokens} tokens`)
  lines.push(`Cache 写入: ${params.totals.usage.cacheWriteTokens} tokens`)
  lines.push(`命中率: ${renderBar(params.totals.cacheHitRate, 18)} ${(params.totals.cacheHitRate * 100).toFixed(1)}%`)
  lines.push('')
  if (params.prefix.current) {
    lines.push(`System prefix: ${params.prefix.current.systemHash}`)
    lines.push(
      `Tools prefix:  ${params.prefix.current.toolsHash} (${params.prefix.current.toolCount} tools, ${params.prefix.current.activeToolSchemaTokens} est. tokens)`
    )
    lines.push(`Prefix 状态: ${params.prefix.stable ? '稳定' : '刚发生变化'}`)
    lines.push(`Prefix 变化次数: ${params.prefix.changes}`)
  } else {
    lines.push('Prefix: 尚未观察到模型请求')
  }
  return lines.join('\n')
}

function samePrefix(left: CachePrefixSnapshot, right: CachePrefixSnapshot): boolean {
  return left.systemHash === right.systemHash && left.toolsHash === right.toolsHash
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function renderBar(value: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, value))
  const filled = Math.round(clamped * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}
