/**
 * Prompt cache 前缀追踪与 `/cache` 状态渲染：检测 system/tools 前缀是否稳定。
 */
import { createHash } from 'node:crypto'
import type { PromptSectionCategory, PromptStability } from '../context/prompt-builder'
import type { ToolDefinition } from '../tools/registry'
import type { CacheMode, UsageTotals } from './types'

export const DEFAULT_CACHE_STABLE_PREFIX_TARGET = 0.9
export const MIN_CACHE_KEEPALIVE_INTERVAL_MS = 60_000
const DEFAULT_CACHE_KEEPALIVE_INTERVAL_MS = 0

/** 单次请求前 system prompt 与工具 schema 的前缀指纹。 */
export interface CachePrefixSnapshot {
  systemHash: string
  toolsHash: string
  toolCount: number
  activeToolSchemaTokens: number
  systemSections?: CacheSectionSnapshot[]
  toolSections?: CacheToolSnapshot[]
  removedSystemSections?: CacheSectionSnapshot[]
  removedToolSections?: CacheToolSnapshot[]
  stablePrefixChars?: number
  stablePrefixRatio?: number
}

/** 单个 system prompt 分段的 cache 诊断快照。 */
export interface CacheSectionSnapshot {
  name: string
  enabled: boolean
  hash: string
  chars: number
  stability?: PromptStability
  category?: PromptSectionCategory
  cacheCritical?: boolean
  changed?: boolean
  removed?: boolean
}

/** 单个工具 schema 的 cache 诊断快照。 */
export interface CacheToolSnapshot {
  name: string
  hash: string
  schemaTokens: number
  changed?: boolean
  removed?: boolean
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

/** 读取 prompt cache 稳定前缀目标，非法值回退 0.9。 */
export function readCacheStablePrefixTarget(
  env: { Q_CODE_CACHE_STABLE_PREFIX_TARGET?: string | undefined } = process.env
): number {
  const raw = env.Q_CODE_CACHE_STABLE_PREFIX_TARGET?.trim()
  if (!raw) return DEFAULT_CACHE_STABLE_PREFIX_TARGET
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1
    ? parsed
    : DEFAULT_CACHE_STABLE_PREFIX_TARGET
}

/** prompt cache keepalive 配置；默认关闭，避免无意触发额外模型调用。 */
export function readCacheKeepaliveIntervalMs(
  env: { Q_CODE_CACHE_KEEPALIVE_INTERVAL_MS?: string | undefined } = process.env
): number {
  const raw = env.Q_CODE_CACHE_KEEPALIVE_INTERVAL_MS?.trim()
  if (!raw) return DEFAULT_CACHE_KEEPALIVE_INTERVAL_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_KEEPALIVE_INTERVAL_MS
  return Math.max(MIN_CACHE_KEEPALIVE_INTERVAL_MS, parsed)
}

/**
 * 根据 system prompt 与工具列表生成可比较的前缀快照。
 */
export function createCachePrefixSnapshot(input: {
  systemPrompt: string
  tools: readonly ToolDefinition[]
  activeToolSchemaTokens: number
  systemSections?: Array<{
    name: string
    enabled: boolean
    text: string
    chars: number
    stability?: PromptStability
    category?: PromptSectionCategory
    cacheCritical?: boolean
  }>
}): CachePrefixSnapshot {
  return {
    systemHash: hashText(input.systemPrompt),
    toolsHash: hashText(
      JSON.stringify(
        input.tools.map((tool) => toolSchemaFingerprint(tool))
      )
    ),
    toolCount: input.tools.length,
    activeToolSchemaTokens: input.activeToolSchemaTokens,
    toolSections: snapshotTools(input.tools),
    ...(input.systemSections
      ? { systemSections: snapshotSections(input.systemSections) }
      : {})
  }
}

/** 根据上一轮快照标记分段变化，并计算从首段开始连续稳定的前缀比例。 */
export function annotateCachePrefixSnapshot(
  snapshot: CachePrefixSnapshot,
  previous?: CachePrefixSnapshot
): CachePrefixSnapshot {
  const toolAnnotation = annotateToolSections(snapshot.toolSections, previous?.toolSections)
  if (!snapshot.systemSections) {
    if (!toolAnnotation) return snapshot
    return {
      ...snapshot,
      toolSections: toolAnnotation.current,
      ...(toolAnnotation.removed.length > 0 ? { removedToolSections: toolAnnotation.removed } : {})
    }
  }

  const previousSections = previous?.systemSections
  const removedSystemSections: CacheSectionSnapshot[] = []
  let stablePrefixChars = 0
  let prefixStillStable = true
  const totalChars = snapshot.systemSections.reduce((sum, section) => sum + section.chars, 0)
  const systemSections = snapshot.systemSections.map((section, index) => {
    const previousSection = previousSections?.[index]
    const changed =
      previousSections !== undefined &&
      (previousSection === undefined ||
        previousSection.name !== section.name ||
        previousSection.hash !== section.hash ||
        previousSection.enabled !== section.enabled ||
        previousSection.chars !== section.chars)
    if (prefixStillStable && !changed) {
      stablePrefixChars += section.chars
    } else if (changed) {
      prefixStillStable = false
    }
    return { ...section, changed }
  })
  if (previousSections) {
    const currentNames = new Set(snapshot.systemSections.map((section) => section.name))
    for (const previousSection of previousSections) {
      if (currentNames.has(previousSection.name)) continue
      removedSystemSections.push({
        ...previousSection,
        enabled: false,
        chars: 0,
        changed: true,
        removed: true
      })
    }
  }

  return {
    ...snapshot,
    systemSections,
    ...(removedSystemSections.length > 0 ? { removedSystemSections } : {}),
    ...(toolAnnotation
      ? {
          toolSections: toolAnnotation.current,
          ...(toolAnnotation.removed.length > 0 ? { removedToolSections: toolAnnotation.removed } : {})
        }
      : {}),
    stablePrefixChars,
    stablePrefixRatio: totalChars > 0 ? stablePrefixChars / totalChars : 1
  }
}

/** 渲染 Cache Status 多行文本（模式、命中率、前缀稳定性）。 */
export function renderCacheStatus(params: {
  mode: CacheMode
  totals: UsageTotals
  prefix: CachePrefixStatus
  keepaliveIntervalMs?: number
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
    if (params.prefix.current.stablePrefixRatio !== undefined) {
      lines.push(
        `Stable prefix: ${(params.prefix.current.stablePrefixRatio * 100).toFixed(1)}% (${params.prefix.current.stablePrefixChars ?? 0} chars)`
      )
    }
    lines.push(`Prefix 状态: ${params.prefix.stable ? '稳定' : '刚发生变化'}`)
    lines.push(`Prefix 变化次数: ${params.prefix.changes}`)
    if (params.keepaliveIntervalMs && params.keepaliveIntervalMs > 0) {
      lines.push(`Keepalive: 每 ${formatDuration(params.keepaliveIntervalMs)} 保持 cache 热度（实验性）`)
    } else {
      lines.push('Keepalive: 关闭')
    }
    if (params.prefix.current.systemSections) {
      lines.push('')
      lines.push('System sections:')
      const systemSections = [
        ...params.prefix.current.systemSections,
        ...(params.prefix.current.removedSystemSections ?? [])
      ]
      for (const section of systemSections) {
        const status = section.changed ? 'changed' : 'stable '
        const enabled = section.removed ? 'removed' : section.enabled ? 'on     ' : 'off    '
        const stability = (section.stability ?? 'dynamic').padEnd(14)
        const category = (section.category ?? 'other').padEnd(8)
        lines.push(
          `  ${section.name.padEnd(22)} ${status} ${enabled} ${stability} ${category} ${section.hash} ${section.chars} chars`
        )
      }
    }
    if (params.prefix.current.toolSections) {
      const toolSections = [
        ...params.prefix.current.toolSections,
        ...(params.prefix.current.removedToolSections ?? [])
      ]
      const changedTools = toolSections
        .filter((section) => section.changed)
        .map((section) => section.name)
      if (changedTools.length > 0) {
        lines.push('')
        lines.push(`Tools changed: ${changedTools.join(', ')}`)
      }
      lines.push('')
      lines.push('Tool sections:')
      for (const section of toolSections) {
        const status = section.changed ? 'changed' : 'stable '
        const removed = section.removed ? ' removed' : ''
        lines.push(
          `  ${section.name.padEnd(28)} ${status}${removed} ${section.hash} ${section.schemaTokens} est. tokens`
        )
      }
    }
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

function snapshotSections(
  sections: Array<{
    name: string
    enabled: boolean
    text: string
    chars: number
    stability?: PromptStability
    category?: PromptSectionCategory
    cacheCritical?: boolean
  }>
): CacheSectionSnapshot[] {
  return sections.map((section) => ({
    name: section.name,
    enabled: section.enabled,
    hash: hashText(section.text),
    chars: section.chars,
    ...(section.stability ? { stability: section.stability } : {}),
    ...(section.category ? { category: section.category } : {}),
    ...(section.cacheCritical !== undefined ? { cacheCritical: section.cacheCritical } : {})
  }))
}

function snapshotTools(tools: readonly ToolDefinition[]): CacheToolSnapshot[] {
  return tools.map((tool) => {
    const schema = JSON.stringify(toolSchemaFingerprint(tool))
    return {
      name: tool.name,
      hash: hashText(schema),
      schemaTokens: Math.ceil(schema.length / 4)
    }
  })
}

function annotateToolSections(
  current: CacheToolSnapshot[] | undefined,
  previous: CacheToolSnapshot[] | undefined
): { current: CacheToolSnapshot[]; removed: CacheToolSnapshot[] } | undefined {
  if (!current) return undefined

  const annotatedCurrent = current.map((section, index) => {
    const previousSection = previous?.[index]
    const changed =
      previous !== undefined &&
      (previousSection === undefined ||
        previousSection.name !== section.name ||
        previousSection.hash !== section.hash ||
        previousSection.schemaTokens !== section.schemaTokens)
    return { ...section, changed }
  })

  const removed: CacheToolSnapshot[] = []
  if (previous) {
    const currentNames = new Set(current.map((section) => section.name))
    for (const previousSection of previous) {
      if (currentNames.has(previousSection.name)) continue
      removed.push({ ...previousSection, changed: true, removed: true })
    }
  }

  return { current: annotatedCurrent, removed }
}

function toolSchemaFingerprint(tool: ToolDefinition): {
  name: string
  description: string
  parameters: Record<string, unknown>
} {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }
}

function renderBar(value: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, value))
  const filled = Math.round(clamped * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}
