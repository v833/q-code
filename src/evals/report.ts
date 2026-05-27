/**
 * Eval artifact 写入与 Markdown 报告渲染。
 */
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { writeJsonAtomic, writeTextAtomic } from '../utils/atomic-write'
import type { EvalCaseResult, EvalReportFormat, EvalRunArtifact, EvalRunSummary, EvalTraceEvent } from './types'

/** 创建 run 输出目录。 */
export async function ensureEvalRunDirs(outputDir: string): Promise<{ tracesDir: string }> {
  const tracesDir = join(outputDir, 'traces')
  await mkdir(tracesDir, { recursive: true })
  return { tracesDir }
}

/** 写入单个 case 的 trace JSONL。 */
export async function writeTraceFile(filePath: string, traces: EvalTraceEvent[]): Promise<void> {
  await writeTextAtomic(filePath, traces.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

/** 写入 run.json / cases.jsonl 以及可选 Markdown/JUnit 报告。 */
export async function writeEvalArtifact(
  artifact: EvalRunArtifact,
  reportFormats: EvalReportFormat[] = ['json', 'md']
): Promise<void> {
  const outputDir = artifact.summary.outputDir
  await mkdir(outputDir, { recursive: true })
  await writeJsonAtomic(join(outputDir, 'run.json'), artifact.summary)
  await writeTextAtomic(
    join(outputDir, 'cases.jsonl'),
    artifact.results.map((result) => JSON.stringify(result)).join('\n') + '\n'
  )
  if (reportFormats.includes('md')) {
    await writeTextAtomic(join(outputDir, 'report.md'), renderEvalReport(artifact.summary, artifact.results))
  }
  if (reportFormats.includes('junit')) {
    await writeTextAtomic(join(outputDir, 'junit.xml'), renderJUnitReport(artifact.summary, artifact.results))
  }
}

/** 渲染人类可读 Markdown 报告。 */
export function renderEvalReport(summary: EvalRunSummary, results: EvalCaseResult[]): string {
  const lines: string[] = []
  lines.push(`# q-code eval report: ${summary.suiteName}`)
  lines.push('')
  lines.push(`- runId: \`${summary.runId}\``)
  lines.push(`- startedAt: ${summary.startedAt}`)
  lines.push(`- durationMs: ${summary.durationMs}`)
  lines.push(`- result: ${summary.passed}/${summary.resultCount} passed (${formatPercent(summary.passRate)})`)
  lines.push(`- averageScore: ${summary.averageScore}`)
  lines.push(`- averageProgressRate: ${summary.averageProgressRate}`)
  lines.push(`- totalTokens: ${summary.totalUsage.totalTokens}`)
  if (summary.totalEstimatedCostUsd !== undefined) {
    lines.push(`- estimatedCostUsd: $${formatUsd(summary.totalEstimatedCostUsd)}`)
    if (summary.totalUsageCost) {
      lines.push(`- cacheSavedUsd: $${formatUsd(summary.totalUsageCost.savedCost)}`)
    }
    if (summary.unknownCostCases > 0) {
      lines.push(`- unknownCostCases: ${summary.unknownCostCases}`)
    }
  }
  if (summary.langfuseMessage) {
    lines.push(`- langfuse: ${summary.langfuseMessage}`)
  }
  if (summary.langfuseDatasetName) {
    lines.push(`- langfuseDataset: ${summary.langfuseDatasetName}`)
  }
  if (summary.langfuseDatasetRunName) {
    lines.push(`- langfuseDatasetRun: ${summary.langfuseDatasetRunName}`)
  }
  lines.push('')
  lines.push('## Cases')
  lines.push('')
  lines.push('| Case | Result | Score | Progress | Judge | Steps | Tools | Tokens | Cost | Error |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
  for (const result of results) {
    lines.push(
      [
        `| \`${result.caseId}\``,
        result.success ? 'PASS' : 'FAIL',
        result.score.toFixed(3),
        result.progressRate.toFixed(3),
        result.judgeScore !== undefined ? result.judgeScore.toFixed(3) : '',
        String(result.stepCount),
        String(result.toolMetrics.totalCalls),
        String(result.usage.totalTokens),
        result.estimatedCostUsd !== undefined ? `$${formatUsd(result.estimatedCostUsd)}` : '',
        result.errorType ?? ''
      ].join(' | ') + ' |'
    )
  }
  lines.push('')

  const failed = results.filter((result) => !result.success)
  if (failed.length > 0) {
    lines.push('## Failures')
    lines.push('')
    for (const result of failed) {
      lines.push(`### ${result.caseId}`)
      lines.push('')
      lines.push(`- name: ${result.name}`)
      lines.push(`- errorType: ${result.errorType ?? 'unknown'}`)
      if (result.errorMessage) lines.push(`- message: ${result.errorMessage}`)
      lines.push(`- repro: \`${formatReproCommand(summary, result)}\``)
      lines.push(`- trace: \`${relative(summary.outputDir, result.traceFile)}\``)
      if (result.workspaceDir) lines.push(`- workspace: \`${relative(summary.outputDir, result.workspaceDir)}\``)
      if (result.stdoutFile) lines.push(`- stdout: \`${relative(summary.outputDir, result.stdoutFile)}\``)
      if (result.stderrFile) lines.push(`- stderr: \`${relative(summary.outputDir, result.stderrFile)}\``)
      lines.push('')
      for (const check of result.checks.filter((item) => !item.passed)) {
        lines.push(`- ${check.name}: ${check.message ?? 'failed'}`)
      }
      lines.push('')
    }
  }

  lines.push('## Difficulty Breakdown')
  lines.push('')
  lines.push('| Difficulty | Passed | Total | Pass rate | Avg progress |')
  lines.push('| --- | ---: | ---: | ---: | ---: |')
  for (const row of difficultyRows(results)) {
    lines.push(
      `| ${row.difficulty} | ${row.passed} | ${row.total} | ${formatPercent(row.passRate)} | ${row.averageProgress.toFixed(3)} |`
    )
  }
  lines.push('')

  return lines.join('\n')
}

function difficultyRows(results: EvalCaseResult[]): Array<{
  difficulty: string
  passed: number
  total: number
  passRate: number
  averageProgress: number
}> {
  const groups = new Map<string, EvalCaseResult[]>()
  for (const result of results) {
    const key = result.difficulty ?? 'unspecified'
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  return Array.from(groups.entries()).map(([difficulty, rows]) => {
    const passed = rows.filter((row) => row.success).length
    const averageProgress =
      rows.length > 0
        ? rows.reduce((sum, row) => sum + row.progressRate, 0) / rows.length
        : 0
    return {
      difficulty,
      passed,
      total: rows.length,
      passRate: rows.length > 0 ? passed / rows.length : 0,
      averageProgress
    }
  })
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

function formatReproCommand(summary: EvalRunSummary, result: EvalCaseResult): string {
  const sources = summary.sources.length > 0 ? summary.sources.map((source) => quoteArg(source)).join(' ') : 'evals/smoke'
  const common = [
    ...formatFilterArgs(summary),
    ...formatLimitArgs(summary),
    '--repeat',
    String(summary.repeat),
    '--no-langfuse'
  ]
  if (result.caseId.startsWith('__run_limits__.')) {
    return `q-code eval run ${sources} ${common.join(' ')}`
  }
  return `q-code eval run ${sources} --grep ${quoteArg(`^${escapeRegex(result.caseId)}$`)} --repeat 1 --no-langfuse`
}

function quoteArg(value: string): string {
  return JSON.stringify(value)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatFilterArgs(summary: EvalRunSummary): string[] {
  const filters = summary.filters
  if (!filters) return []
  return [
    ...(filters.grep ? ['--grep', quoteArg(filters.grep)] : []),
    ...(filters.tags ?? []).flatMap((tag) => ['--tag', quoteArg(tag)]),
    ...(filters.excludeTags ?? []).flatMap((tag) => ['--exclude-tag', quoteArg(tag)]),
    ...(filters.difficulties ?? []).flatMap((difficulty) => ['--difficulty', difficulty]),
    ...(filters.modes ?? []).flatMap((mode) => ['--mode', mode])
  ]
}

function formatLimitArgs(summary: EvalRunSummary): string[] {
  const limits = summary.limits
  if (!limits) return []
  return [
    ...(limits.maxCases !== undefined ? ['--max-cases', String(limits.maxCases)] : []),
    ...(limits.maxDurationMs !== undefined ? ['--max-duration-ms', String(limits.maxDurationMs)] : []),
    ...(limits.maxTotalTokens !== undefined ? ['--max-total-tokens', String(limits.maxTotalTokens)] : []),
    ...(limits.maxCostUsd !== undefined ? ['--max-cost-usd', String(limits.maxCostUsd)] : [])
  ]
}

/** 渲染 CI 可读取的 JUnit XML。 */
export function renderJUnitReport(summary: EvalRunSummary, results: EvalCaseResult[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${escapeXml(`q-code eval ${summary.suiteName}`)}" tests="${results.length}" failures="${summary.failed}" time="${formatSeconds(summary.durationMs)}">`
  ]
  for (const result of results) {
    lines.push(
      `  <testcase classname="${escapeXml(summary.suiteName)}" name="${escapeXml(result.runCaseId)}" time="${formatSeconds(result.durationMs)}">`
    )
    if (!result.success) {
      const message = result.errorMessage ?? result.errorType ?? 'eval failed'
      lines.push(`    <failure message="${escapeXml(message)}">`)
      lines.push(escapeXml(result.checks.filter((check) => !check.passed).map((check) => check.message ?? check.name).join('\n')))
      lines.push('    </failure>')
    }
    lines.push('  </testcase>')
  }
  lines.push('</testsuite>')
  lines.push('')
  return lines.join('\n')
}

function formatSeconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(3)
}

function formatUsd(value: number): string {
  return (Math.round(value * 1_000_000) / 1_000_000).toFixed(6)
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
