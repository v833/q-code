/**
 * 上下文用量报告：token 分解、阈值状态与 16×16 ASCII 矩阵可视化。
 */
import type { ModelMessage } from 'ai'
import {
  buildTokenBudgetSnapshot,
  estimateMessagesTokens,
  estimateTextTokens,
  type TokenBudgetSnapshot,
  type UsageAnchor
} from './token-budget'

const MATRIX_SIZE = 16
const MATRIX_CELLS = MATRIX_SIZE * MATRIX_SIZE

/** 构建上下文报告所需的配置（与 token 预算一致）。 */
export interface ContextReportOptions {
  modelName: string
  systemPrompt: string
  activeToolSchemaTokens: number
  contextLimitTokens: number
  compactTriggerRatio: number
  warningRatio?: number
  blockingRatio?: number
  reservedOutputTokens?: number
  usageAnchor?: UsageAnchor
}

/** System/Tools/Messages/Free/Buffer/Reserved 分项 token 估算。 */
export interface ContextBreakdown {
  systemTokens: number
  toolTokens: number
  messageTokens: number
  freeTokens: number
  compactBufferTokens: number
  reservedOutputTokens: number
  overLimitTokens: number
}

/** 完整上下文报告：快照、分解与矩阵字符串。 */
export interface ContextReport {
  modelName: string
  snapshot: TokenBudgetSnapshot
  breakdown: ContextBreakdown
  matrix: string
}

/**
 * 根据消息与配置生成上下文报告。
 */
export function buildContextReport(
  messages: readonly ModelMessage[],
  options: ContextReportOptions
): ContextReport {
  const snapshot = buildTokenBudgetSnapshot(messages, options)
  const systemTokens = estimateTextTokens(options.systemPrompt)
  const toolTokens = options.activeToolSchemaTokens
  const messageTokens = estimateMessagesTokens(messages)
  const reservedOutputTokens = Math.max(0, snapshot.limit - snapshot.effectiveLimit)
  const compactBufferTokens = Math.max(0, snapshot.blockingThreshold - snapshot.compactThreshold)
  const freeTokens = Math.max(0, snapshot.compactThreshold - snapshot.used)
  const totalBreakdownTokens =
    systemTokens +
    toolTokens +
    messageTokens +
    freeTokens +
    compactBufferTokens +
    reservedOutputTokens
  const breakdown = {
    systemTokens,
    toolTokens,
    messageTokens,
    freeTokens,
    compactBufferTokens,
    reservedOutputTokens,
    overLimitTokens: Math.max(0, totalBreakdownTokens - snapshot.limit)
  }

  return {
    modelName: options.modelName,
    snapshot,
    breakdown,
    matrix: renderContextMatrix(snapshot.limit, breakdown)
  }
}

/** 将 `ContextReport` 格式化为面向终端的多行文本。 */
export function renderContextReport(report: ContextReport): string {
  const usedPercent = formatPercent(report.snapshot.ratio)
  return [
    'Context',
    '',
    `${report.snapshot.state.toUpperCase()} ${renderBar(report.snapshot.ratio, 24)} ${usedPercent}`,
    '',
    report.matrix,
    '',
    `模型: ${report.modelName}`,
    `已用: ${report.snapshot.used}/${report.snapshot.limit} tokens (${usedPercent})`,
    `状态: ${report.snapshot.state}`,
    `Warning 阈值: ${report.snapshot.warningThreshold}`,
    `Compact 阈值: ${report.snapshot.compactThreshold}`,
    `Blocking 阈值: ${report.snapshot.blockingThreshold}`,
    '',
    `S System prompt: ${report.breakdown.systemTokens}`,
    `T 工具 schemas:   ${report.breakdown.toolTokens}`,
    `M 对话消息:       ${report.breakdown.messageTokens}`,
    `F 距离压缩余量:   ${report.breakdown.freeTokens}`,
    `B 压缩缓冲区:     ${report.breakdown.compactBufferTokens}`,
    `R 输出预留:       ${report.breakdown.reservedOutputTokens}`,
    ...(report.breakdown.overLimitTokens > 0
      ? [`! 超出窗口:       ${report.breakdown.overLimitTokens}`]
      : [])
  ].join('\n')
}

/**
 * 将 token 分解映射为 16×16 字符矩阵（S/T/M/F/B/R/.）。
 */
export function renderContextMatrix(limit: number, breakdown: ContextBreakdown): string {
  const allocations = allocateMatrixCells(limit, [
    { label: 'S', tokens: breakdown.systemTokens },
    { label: 'T', tokens: breakdown.toolTokens },
    { label: 'M', tokens: breakdown.messageTokens },
    { label: 'F', tokens: breakdown.freeTokens },
    { label: 'B', tokens: breakdown.compactBufferTokens },
    { label: 'R', tokens: breakdown.reservedOutputTokens }
  ])
  const cells = allocations.flatMap((entry) =>
    Array.from({ length: entry.cells }, () => entry.label)
  )

  while (cells.length < MATRIX_CELLS) cells.push('.')

  const lines: string[] = []
  for (let row = 0; row < MATRIX_SIZE; row++) {
    lines.push(cells.slice(row * MATRIX_SIZE, (row + 1) * MATRIX_SIZE).join(' '))
  }
  return lines.join('\n')
}

interface MatrixCategory {
  label: string
  tokens: number
}

interface MatrixAllocation {
  label: string
  cells: number
  remainder: number
}

/** 按 token 比例分配 256 格，余数用最大小数部分优先补齐。 */
function allocateMatrixCells(limit: number, categories: MatrixCategory[]): MatrixAllocation[] {
  const positive = categories.filter((category) => category.tokens > 0)
  if (positive.length === 0 || limit <= 0) return []

  const totalTokens = positive.reduce((sum, category) => sum + category.tokens, 0)
  const denominator = Math.max(limit, totalTokens)
  const usedCells = Math.min(
    MATRIX_CELLS,
    Math.max(positive.length, Math.round((totalTokens / denominator) * MATRIX_CELLS))
  )
  const allocations = positive.map((category) => {
    const exact = (category.tokens / denominator) * MATRIX_CELLS
    const floor = Math.floor(exact)
    return {
      label: category.label,
      cells: Math.max(1, floor),
      remainder: exact - floor
    }
  })

  let allocated = allocations.reduce((sum, allocation) => sum + allocation.cells, 0)
  if (allocated < usedCells) {
    const byRemainder = [...allocations].sort((left, right) => right.remainder - left.remainder)
    for (let index = 0; allocated < usedCells; index++) {
      byRemainder[index % byRemainder.length]!.cells++
      allocated++
    }
  } else if (allocated > usedCells) {
    const byRemainder = [...allocations].sort((left, right) => left.remainder - right.remainder)
    for (let index = 0; allocated > usedCells; index++) {
      const allocation = byRemainder[index % byRemainder.length]!
      if (allocation.cells <= 1) continue
      allocation.cells--
      allocated--
    }
  }

  return allocations
}

function formatPercent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`
}

function renderBar(value: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, value))
  const filled = Math.round(clamped * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}
