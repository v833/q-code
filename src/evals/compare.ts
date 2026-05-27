/**
 * Eval baseline/candidate 对比：读取两个 run artifact 并输出回归摘要。
 */
import { existsSync, statSync } from 'node:fs'
import { cp, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { EvalCaseResult, EvalRunSummary } from './types'

/** Eval run 对比结果。 */
export interface EvalCompareResult {
  baseline: EvalRunSummary
  candidate: EvalRunSummary
  newFailures: string[]
  fixedFailures: string[]
  scoreDelta: number
  progressDelta: number
  tokenDelta: number
  costDelta?: number
}

/** 从两个 run 目录或 run.json 文件进行对比。 */
export async function compareEvalRuns(
  baselinePath: string,
  candidatePath: string,
  cwd: string = process.cwd()
): Promise<EvalCompareResult> {
  const baseline = await readRun(resolveRunRef(baselinePath, cwd))
  const candidate = await readRun(resolveRunRef(candidatePath, cwd))
  const baselineCases = await readCases(baseline.outputDir)
  const candidateCases = await readCases(candidate.outputDir)

  const baselineByCase = summarizeByCase(baselineCases)
  const candidateByCase = summarizeByCase(candidateCases)
  const newFailures: string[] = []
  const fixedFailures: string[] = []

  for (const [caseId, candidatePassed] of candidateByCase) {
    const baselinePassed = baselineByCase.get(caseId)
    if (baselinePassed === true && candidatePassed === false) newFailures.push(caseId)
    if (baselinePassed === false && candidatePassed === true) fixedFailures.push(caseId)
  }

  return {
    baseline: baseline.summary,
    candidate: candidate.summary,
    newFailures,
    fixedFailures,
    scoreDelta: round(candidate.summary.averageScore - baseline.summary.averageScore),
    progressDelta: round(candidate.summary.averageProgressRate - baseline.summary.averageProgressRate),
    tokenDelta: candidate.summary.totalUsage.totalTokens - baseline.summary.totalUsage.totalTokens,
    ...(
      candidate.summary.totalEstimatedCostUsd !== undefined && baseline.summary.totalEstimatedCostUsd !== undefined
        ? { costDelta: roundCost(candidate.summary.totalEstimatedCostUsd - baseline.summary.totalEstimatedCostUsd) }
        : {}
    )
  }
}

/** 将某个 run 复制为命名 baseline。 */
export async function promoteEvalBaseline(
  runPath: string,
  name: string,
  cwd: string = process.cwd()
): Promise<string> {
  const source = dirname(resolveRunRef(runPath, cwd))
  const target = join(cwd, '.q-code', 'evals', 'baselines', sanitizeBaselineName(name))
  await cp(source, target, {
    recursive: true,
    force: true
  })
  return target
}

/** 渲染 compare 命令输出。 */
export function renderEvalCompare(result: EvalCompareResult): string {
  return [
    `Baseline: ${result.baseline.runId}`,
    `Candidate: ${result.candidate.runId}`,
    '',
    `Pass rate: ${formatPercent(result.baseline.passRate)} -> ${formatPercent(result.candidate.passRate)}`,
    `Average score delta: ${formatSigned(result.scoreDelta)}`,
    `Progress delta: ${formatSigned(result.progressDelta)}`,
    `Token delta: ${formatSigned(result.tokenDelta)}`,
    ...(result.costDelta !== undefined ? [`Cost delta: ${formatSignedUsd(result.costDelta)}`] : []),
    '',
    `New failures (${result.newFailures.length}): ${
      result.newFailures.length > 0 ? result.newFailures.join(', ') : '(none)'
    }`,
    `Fixed failures (${result.fixedFailures.length}): ${
      result.fixedFailures.length > 0 ? result.fixedFailures.join(', ') : '(none)'
    }`
  ].join('\n')
}

async function readRun(pathLike: string): Promise<{ summary: EvalRunSummary; outputDir: string }> {
  const filePath = pathLike.endsWith('.json') ? pathLike : `${pathLike.replace(/[\\/]$/, '')}/run.json`
  const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as EvalRunSummary | { summary: EvalRunSummary }
  return {
    summary: 'summary' in parsed ? parsed.summary : parsed,
    outputDir: dirname(filePath)
  }
}

function resolveRunRef(pathLike: string, cwd: string): string {
  const direct = resolve(cwd, pathLike)
  if (existsSync(`${direct.replace(/[\\/]$/, '')}/run.json`)) return `${direct.replace(/[\\/]$/, '')}/run.json`
  if (existsSync(direct) && statSync(direct).isFile()) return direct
  const baselinePath = join(cwd, '.q-code', 'evals', 'baselines', sanitizeBaselineName(pathLike), 'run.json')
  if (existsSync(baselinePath)) return baselinePath
  return direct
}

async function readCases(outputDir: string): Promise<EvalCaseResult[]> {
  const raw = await readFile(`${outputDir.replace(/[\\/]$/, '')}/cases.jsonl`, 'utf-8')
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalCaseResult)
}

function summarizeByCase(results: EvalCaseResult[]): Map<string, boolean> {
  const grouped = new Map<string, EvalCaseResult[]>()
  for (const result of results) {
    grouped.set(result.caseId, [...(grouped.get(result.caseId) ?? []), result])
  }
  const summary = new Map<string, boolean>()
  for (const [caseId, rows] of grouped) {
    summary.set(caseId, rows.every((row) => row.success))
  }
  return summary
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

function formatSigned(value: number): string {
  return value >= 0 ? `+${value}` : String(value)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function formatSignedUsd(value: number): string {
  const prefix = value >= 0 ? '+' : ''
  return `${prefix}$${Math.abs(roundCost(value)).toFixed(6)}`
}

function sanitizeBaselineName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!sanitized) throw new Error('baseline 名称不能为空')
  return sanitized
}
