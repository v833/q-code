/**
 * Eval 趋势看板：读取历史 run.json，生成本地 JSON/Markdown 趋势报告。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import fg from 'fast-glob'
import { writeJsonAtomic, writeTextAtomic } from '../utils/atomic-write'
import type { EvalRunSummary, EvalTrendArtifact, EvalTrendRunPoint } from './types'

/** 生成趋势看板。 */
export async function buildEvalTrend(options: {
  cwd?: string
  runsDir?: string
  outputDir?: string
  suiteName?: string
  limit?: number
} = {}): Promise<EvalTrendArtifact> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const runsDir = resolve(options.runsDir ?? join(cwd, '.q-code', 'evals', 'runs'))
  const outputDir = resolve(options.outputDir ?? join(cwd, '.q-code', 'evals', 'trends'))
  const limit = normalizeLimit(options.limit)
  const summaries = await readRunSummaries(runsDir)
  const filtered = options.suiteName
    ? summaries.filter((summary) => summary.suiteName === options.suiteName)
    : summaries
  const runs = filtered
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .slice(-limit)
    .map(toTrendPoint)
  const artifact: EvalTrendArtifact = {
    generatedAt: new Date().toISOString(),
    cwd,
    runsDir,
    outputDir,
    ...(options.suiteName ? { suiteName: options.suiteName } : {}),
    limit,
    runs,
    ...(runs.length >= 2 ? { deltas: calculateDeltas(runs[0]!, runs.at(-1)!) } : {})
  }

  await mkdir(outputDir, { recursive: true })
  await writeJsonAtomic(join(outputDir, 'trend.json'), artifact)
  await writeTextAtomic(join(outputDir, 'trend.md'), renderEvalTrendReport(artifact))
  return artifact
}

/** 渲染趋势 Markdown。 */
export function renderEvalTrendReport(artifact: EvalTrendArtifact): string {
  const lines: string[] = []
  lines.push('# q-code eval trend')
  lines.push('')
  lines.push(`- generatedAt: ${artifact.generatedAt}`)
  lines.push(`- runsDir: \`${artifact.runsDir}\``)
  if (artifact.suiteName) lines.push(`- suiteName: ${artifact.suiteName}`)
  lines.push(`- runCount: ${artifact.runs.length}`)
  if (artifact.deltas) {
    lines.push(`- passRateDelta: ${formatSignedPercent(artifact.deltas.passRate)}`)
    lines.push(`- averageScoreDelta: ${formatSigned(artifact.deltas.averageScore)}`)
    lines.push(`- averageProgressDelta: ${formatSigned(artifact.deltas.averageProgressRate)}`)
    lines.push(`- totalTokensDelta: ${formatSigned(artifact.deltas.totalTokens)}`)
    if (artifact.deltas.totalEstimatedCostUsd !== undefined) {
      lines.push(`- estimatedCostDelta: $${formatSigned(artifact.deltas.totalEstimatedCostUsd)}`)
    }
  }
  lines.push('')
  lines.push('| Started | Suite | Run | Result | Pass rate | Avg score | Avg progress | Tokens | Cost |')
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const run of artifact.runs) {
    lines.push(
      [
        `| ${run.startedAt}`,
        run.suiteName,
        `\`${run.runId}\``,
        `${run.passed}/${run.resultCount}`,
        formatPercent(run.passRate),
        run.averageScore.toFixed(3),
        run.averageProgressRate.toFixed(3),
        String(run.totalTokens),
        run.totalEstimatedCostUsd !== undefined ? `$${formatUsd(run.totalEstimatedCostUsd)}` : ''
      ].join(' | ') + ' |'
    )
  }
  lines.push('')
  return lines.join('\n')
}

async function readRunSummaries(runsDir: string): Promise<EvalRunSummary[]> {
  if (!existsSync(runsDir)) return []
  const files = await fg('*/run.json', { cwd: runsDir, absolute: true, onlyFiles: true })
  const summaries: EvalRunSummary[] = []
  for (const file of files) {
    try {
      summaries.push(JSON.parse(await readFile(file, 'utf-8')) as EvalRunSummary)
    } catch {
      // 忽略损坏或旧 schema run，趋势看板只聚合可解析数据。
    }
  }
  return summaries
}

function toTrendPoint(summary: EvalRunSummary): EvalTrendRunPoint {
  return {
    runId: summary.runId,
    suiteName: summary.suiteName,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    durationMs: summary.durationMs,
    resultCount: summary.resultCount,
    passed: summary.passed,
    failed: summary.failed,
    passRate: summary.passRate,
    averageScore: summary.averageScore,
    averageProgressRate: summary.averageProgressRate,
    totalTokens: summary.totalUsage.totalTokens,
    ...(summary.totalEstimatedCostUsd !== undefined ? { totalEstimatedCostUsd: summary.totalEstimatedCostUsd } : {}),
    outputDir: summary.outputDir
  }
}

function calculateDeltas(first: EvalTrendRunPoint, latest: EvalTrendRunPoint): EvalTrendArtifact['deltas'] {
  return {
    passRate: round(latest.passRate - first.passRate),
    averageScore: round(latest.averageScore - first.averageScore),
    averageProgressRate: round(latest.averageProgressRate - first.averageProgressRate),
    totalTokens: latest.totalTokens - first.totalTokens,
    ...(first.totalEstimatedCostUsd !== undefined && latest.totalEstimatedCostUsd !== undefined
      ? { totalEstimatedCostUsd: roundCost(latest.totalEstimatedCostUsd - first.totalEstimatedCostUsd) }
      : {})
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return 30
  return Math.floor(limit)
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatPercent(value)}`
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`
}

function formatUsd(value: number): string {
  return roundCost(value).toFixed(6)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
