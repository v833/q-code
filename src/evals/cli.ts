/**
 * `q-code eval` 子命令：列出、运行和对比 Agent 评测任务。
 */
import { applyRuntimeConfig } from '../config/runtime-config'
import { compareEvalRuns, promoteEvalBaseline, renderEvalCompare } from './compare'
import { loadEvalCases } from './loader'
import { runEvalSuite } from './runner'
import { buildEvalTrend } from './trend'
import type { EvalCaseFilter, EvalDifficulty, EvalMode, EvalReportFormat, EvalRunLimits } from './types'

/** 执行 eval CLI。 */
export async function runEvalCli(argv: string[], cwd: string = process.cwd()): Promise<number> {
  applyRuntimeConfig(cwd)
  const [subcommand = 'help', ...rest] = argv

  try {
    if (subcommand === 'list') {
      const options = parseListArgs(rest)
      const loaded = await loadEvalCases(options.paths, cwd)
      const cases = filterForList(loaded.cases, options.filters)
      console.log(`Eval suite: ${loaded.suiteName}`)
      console.log(`Sources: ${loaded.sources.length}`)
      for (const source of loaded.sources) console.log(`  - ${source}`)
      console.log('')
      for (const caseDef of cases) {
        const tags = caseDef.tags.length > 0 ? ` [${caseDef.tags.join(', ')}]` : ''
        const difficulty = caseDef.difficulty ? ` difficulty=${caseDef.difficulty}` : ''
        console.log(`- ${caseDef.id}${tags}${difficulty}`)
        console.log(`  ${caseDef.name}`)
      }
      return 0
    }

    if (subcommand === 'run') {
      const options = parseRunArgs(rest)
      const artifact = await runEvalSuite({
        cwd,
        paths: options.paths,
        outputDir: options.outputDir,
        repeat: options.repeat,
        concurrency: options.concurrency,
        reportFormats: options.reportFormats,
        filters: options.filters,
        limits: options.limits,
        exportLangfuse: options.exportLangfuse,
        exportLangfuseDatasets: options.exportLangfuseDatasets,
        allowRealModel: options.allowRealModel,
        judgeEnabled: options.judgeEnabled,
        strictLangfuse: options.strictLangfuse
      })
      console.log(formatRunSummary(artifact.summary))
      return artifact.summary.failed === 0 ? 0 : 1
    }

    if (subcommand === 'compare') {
      if (rest.length < 2) {
        console.error('用法: q-code eval compare <baseline-run-dir|run.json> <candidate-run-dir|run.json>')
        return 1
      }
      const result = await compareEvalRuns(rest[0]!, rest[1]!, cwd)
      console.log(renderEvalCompare(result))
      return result.newFailures.length === 0 ? 0 : 1
    }

    if (subcommand === 'promote') {
      const options = parsePromoteArgs(rest)
      const target = await promoteEvalBaseline(options.runPath, options.name, cwd)
      console.log(`Baseline '${options.name}' promoted: ${target}`)
      return 0
    }

    if (subcommand === 'trend') {
      const options = parseTrendArgs(rest)
      const artifact = await buildEvalTrend({
        cwd,
        ...(options.runsDir ? { runsDir: options.runsDir } : {}),
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
        ...(options.suiteName ? { suiteName: options.suiteName } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {})
      })
      console.log(formatTrendSummary(artifact))
      return 0
    }

    console.log(formatEvalHelp())
    return subcommand === 'help' || subcommand === '--help' || subcommand === '-h' ? 0 : 1
  } catch (error) {
    console.error(`eval 失败: ${formatError(error)}`)
    return 1
  }
}

function parseListArgs(argv: string[]): { paths: string[]; filters?: EvalCaseFilter } {
  const parsed = parsePathAndFilterArgs(argv)
  return { paths: parsed.paths.length > 0 ? parsed.paths : ['evals/smoke'], ...(parsed.filters ? { filters: parsed.filters } : {}) }
}

function parseRunArgs(argv: string[]): {
  paths: string[]
  outputDir?: string
  repeat?: number
  concurrency?: number
  reportFormats?: EvalReportFormat[]
  filters?: EvalCaseFilter
  limits?: EvalRunLimits
  exportLangfuse?: boolean
  exportLangfuseDatasets?: boolean
  allowRealModel?: boolean
  judgeEnabled?: boolean
  strictLangfuse?: boolean
} {
  const parsed = parsePathAndFilterArgs(argv)
  let outputDir: string | undefined
  let repeat: number | undefined
  let concurrency: number | undefined
  let reportFormats: EvalReportFormat[] | undefined
  const limits: EvalRunLimits = {}
  let exportLangfuse: boolean | undefined
  let exportLangfuseDatasets: boolean | undefined
  let allowRealModel = false
  let judgeEnabled = false
  let strictLangfuse = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--out' || arg === '--output-dir') {
      outputDir = requireNext(argv, ++index, arg)
    } else if (arg.startsWith('--out=')) {
      outputDir = arg.slice('--out='.length)
    } else if (arg.startsWith('--output-dir=')) {
      outputDir = arg.slice('--output-dir='.length)
    } else if (arg === '--repeat') {
      repeat = parsePositiveInt(requireNext(argv, ++index, arg), arg)
    } else if (arg.startsWith('--repeat=')) {
      repeat = parsePositiveInt(arg.slice('--repeat='.length), '--repeat')
    } else if (arg === '--concurrency') {
      concurrency = parsePositiveInt(requireNext(argv, ++index, arg), arg)
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = parsePositiveInt(arg.slice('--concurrency='.length), '--concurrency')
    } else if (arg === '--no-langfuse') {
      exportLangfuse = false
    } else if (arg === '--langfuse') {
      exportLangfuse = true
    } else if (arg === '--langfuse-datasets') {
      exportLangfuse = true
      exportLangfuseDatasets = true
    } else if (arg === '--strict-langfuse') {
      strictLangfuse = true
    } else if (arg === '--allow-real-model') {
      allowRealModel = true
    } else if (arg === '--judge') {
      judgeEnabled = true
    } else if (arg === '--report') {
      reportFormats = parseReportFormats(requireNext(argv, ++index, arg))
    } else if (arg.startsWith('--report=')) {
      reportFormats = parseReportFormats(arg.slice('--report='.length))
    } else if (arg === '--max-cases') {
      limits.maxCases = parsePositiveInt(requireNext(argv, ++index, arg), arg)
    } else if (arg.startsWith('--max-cases=')) {
      limits.maxCases = parsePositiveInt(arg.slice('--max-cases='.length), '--max-cases')
    } else if (arg === '--max-duration-ms') {
      limits.maxDurationMs = parsePositiveInt(requireNext(argv, ++index, arg), arg)
    } else if (arg.startsWith('--max-duration-ms=')) {
      limits.maxDurationMs = parsePositiveInt(arg.slice('--max-duration-ms='.length), '--max-duration-ms')
    } else if (arg === '--max-total-tokens') {
      limits.maxTotalTokens = parsePositiveInt(requireNext(argv, ++index, arg), arg)
    } else if (arg.startsWith('--max-total-tokens=')) {
      limits.maxTotalTokens = parsePositiveInt(arg.slice('--max-total-tokens='.length), '--max-total-tokens')
    } else if (arg === '--max-cost-usd') {
      limits.maxCostUsd = parseNonNegativeNumber(requireNext(argv, ++index, arg), arg)
    } else if (arg.startsWith('--max-cost-usd=')) {
      limits.maxCostUsd = parseNonNegativeNumber(arg.slice('--max-cost-usd='.length), '--max-cost-usd')
    } else if (isFilterArg(arg)) {
      if (arg === '--grep' || arg === '--tag' || arg === '--exclude-tag' || arg === '--difficulty' || arg === '--mode') index++
    } else if (arg.startsWith('-')) {
      throw new Error(`未知 eval run 参数: ${arg}`)
    }
  }

  return {
    paths: parsed.paths.length > 0 ? parsed.paths : ['evals/smoke'],
    ...(outputDir ? { outputDir } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(reportFormats !== undefined ? { reportFormats } : {}),
    ...(parsed.filters ? { filters: parsed.filters } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(exportLangfuse !== undefined ? { exportLangfuse } : {}),
    ...(exportLangfuseDatasets !== undefined ? { exportLangfuseDatasets } : {}),
    ...(allowRealModel ? { allowRealModel } : {}),
    ...(judgeEnabled ? { judgeEnabled } : {}),
    ...(strictLangfuse ? { strictLangfuse } : {})
  }
}

function parseTrendArgs(argv: string[]): {
  runsDir?: string
  outputDir?: string
  suiteName?: string
  limit?: number
} {
  let runsDir: string | undefined
  let outputDir: string | undefined
  let suiteName: string | undefined
  let limit: number | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--runs-dir') {
      runsDir = requireNext(argv, ++index, arg)
    } else if (arg.startsWith('--runs-dir=')) {
      runsDir = arg.slice('--runs-dir='.length)
    } else if (arg === '--out' || arg === '--output-dir') {
      outputDir = requireNext(argv, ++index, arg)
    } else if (arg.startsWith('--out=')) {
      outputDir = arg.slice('--out='.length)
    } else if (arg.startsWith('--output-dir=')) {
      outputDir = arg.slice('--output-dir='.length)
    } else if (arg === '--suite') {
      suiteName = requireNext(argv, ++index, arg)
    } else if (arg.startsWith('--suite=')) {
      suiteName = arg.slice('--suite='.length)
    } else if (arg === '--limit') {
      limit = parsePositiveInt(requireNext(argv, ++index, arg), arg)
    } else if (arg.startsWith('--limit=')) {
      limit = parsePositiveInt(arg.slice('--limit='.length), '--limit')
    } else {
      throw new Error(`未知 eval trend 参数: ${arg}`)
    }
  }
  return {
    ...(runsDir ? { runsDir } : {}),
    ...(outputDir ? { outputDir } : {}),
    ...(suiteName ? { suiteName } : {}),
    ...(limit !== undefined ? { limit } : {})
  }
}

function parsePromoteArgs(argv: string[]): { runPath: string; name: string } {
  const runPath = argv[0]
  if (!runPath) throw new Error('promote 缺少 run 路径')
  let name = 'main'
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--as') {
      name = requireNext(argv, ++index, arg)
    } else if (arg.startsWith('--as=')) {
      name = arg.slice('--as='.length)
    } else {
      throw new Error(`未知 eval promote 参数: ${arg}`)
    }
  }
  return { runPath, name }
}

function parsePathAndFilterArgs(argv: string[]): { paths: string[]; filters?: EvalCaseFilter } {
  const paths: string[] = []
  const filters: EvalCaseFilter = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--grep') {
      filters.grep = requireNext(argv, ++index, arg)
    } else if (arg.startsWith('--grep=')) {
      filters.grep = arg.slice('--grep='.length)
    } else if (arg === '--tag') {
      filters.tags = appendList(filters.tags, requireNext(argv, ++index, arg))
    } else if (arg.startsWith('--tag=')) {
      filters.tags = appendList(filters.tags, arg.slice('--tag='.length))
    } else if (arg === '--exclude-tag') {
      filters.excludeTags = appendList(filters.excludeTags, requireNext(argv, ++index, arg))
    } else if (arg.startsWith('--exclude-tag=')) {
      filters.excludeTags = appendList(filters.excludeTags, arg.slice('--exclude-tag='.length))
    } else if (arg === '--difficulty') {
      filters.difficulties = appendDifficultyList(filters.difficulties, requireNext(argv, ++index, arg))
    } else if (arg.startsWith('--difficulty=')) {
      filters.difficulties = appendDifficultyList(filters.difficulties, arg.slice('--difficulty='.length))
    } else if (arg === '--mode') {
      filters.modes = appendModeList(filters.modes, requireNext(argv, ++index, arg))
    } else if (arg.startsWith('--mode=')) {
      filters.modes = appendModeList(filters.modes, arg.slice('--mode='.length))
    } else if (arg.startsWith('-')) {
      if (isRunOnlyArg(arg)) {
        if (!arg.includes('=') && expectsValue(arg)) index++
      } else {
        throw new Error(`未知 eval 参数: ${arg}`)
      }
    } else {
      paths.push(arg)
    }
  }

  return {
    paths,
    ...(Object.keys(filters).length > 0 ? { filters } : {})
  }
}

function filterForList<T extends { id: string; name: string; prompt: string; tags: string[]; difficulty?: EvalDifficulty; mode: EvalMode }>(
  cases: T[],
  filters: EvalCaseFilter | undefined
): T[] {
  if (!filters) return cases
  const grep = filters.grep ? new RegExp(filters.grep, 'i') : undefined
  const tags = new Set(filters.tags ?? [])
  const excludeTags = new Set(filters.excludeTags ?? [])
  const difficulties = new Set(filters.difficulties ?? [])
  const modes = new Set(filters.modes ?? [])
  return cases.filter((caseDef) => {
    if (grep && !grep.test(`${caseDef.id}\n${caseDef.name}\n${caseDef.prompt}`)) return false
    if (tags.size > 0 && !caseDef.tags.some((tag) => tags.has(tag))) return false
    if (excludeTags.size > 0 && caseDef.tags.some((tag) => excludeTags.has(tag))) return false
    if (difficulties.size > 0 && (!caseDef.difficulty || !difficulties.has(caseDef.difficulty))) return false
    if (modes.size > 0 && !modes.has(caseDef.mode)) return false
    return true
  })
}

function appendList(existing: string[] | undefined, raw: string): string[] {
  return [...(existing ?? []), ...raw.split(',').map((item) => item.trim()).filter(Boolean)]
}

function appendDifficultyList(existing: EvalDifficulty[] | undefined, raw: string): EvalDifficulty[] {
  const allowed = new Set<EvalDifficulty>(['easy', 'medium', 'hard'])
  return appendList(existing, raw).map((item) => {
    if (!allowed.has(item as EvalDifficulty)) throw new Error(`未知 difficulty: ${item}`)
    return item as EvalDifficulty
  })
}

function appendModeList(existing: EvalMode[] | undefined, raw: string): EvalMode[] {
  const allowed = new Set<EvalMode>(['mock-agent', 'cli-subprocess', 'real-agent'])
  return appendList(existing, raw).map((item) => {
    if (!allowed.has(item as EvalMode)) throw new Error(`未知 mode: ${item}`)
    return item as EvalMode
  })
}

function isFilterArg(arg: string): boolean {
  return (
    arg === '--grep' ||
    arg.startsWith('--grep=') ||
    arg === '--tag' ||
    arg.startsWith('--tag=') ||
    arg === '--exclude-tag' ||
    arg.startsWith('--exclude-tag=') ||
    arg === '--difficulty' ||
    arg.startsWith('--difficulty=') ||
    arg === '--mode' ||
    arg.startsWith('--mode=')
  )
}

function isRunOnlyArg(arg: string): boolean {
  return (
    arg === '--out' ||
    arg.startsWith('--out=') ||
    arg === '--output-dir' ||
    arg.startsWith('--output-dir=') ||
    arg === '--repeat' ||
    arg.startsWith('--repeat=') ||
    arg === '--concurrency' ||
    arg.startsWith('--concurrency=') ||
    arg === '--report' ||
    arg.startsWith('--report=') ||
    arg === '--langfuse' ||
    arg === '--no-langfuse' ||
    arg === '--langfuse-datasets' ||
    arg === '--strict-langfuse' ||
    arg === '--allow-real-model' ||
    arg === '--judge' ||
    arg === '--max-cases' ||
    arg.startsWith('--max-cases=') ||
    arg === '--max-duration-ms' ||
    arg.startsWith('--max-duration-ms=') ||
    arg === '--max-total-tokens' ||
    arg.startsWith('--max-total-tokens=') ||
    arg === '--max-cost-usd' ||
    arg.startsWith('--max-cost-usd=')
  )
}

function expectsValue(arg: string): boolean {
  return ['--out', '--output-dir', '--repeat', '--concurrency', '--report', '--max-cases', '--max-duration-ms', '--max-total-tokens', '--max-cost-usd'].includes(arg)
}

function formatRunSummary(summary: {
  runId: string
  suiteName: string
  passed: number
  failed: number
  resultCount: number
  passRate: number
  averageScore: number
  averageProgressRate: number
  totalEstimatedCostUsd?: number
  outputDir: string
  langfuseMessage?: string
}): string {
  return [
    `Eval run: ${summary.runId}`,
    `Suite: ${summary.suiteName}`,
    `Result: ${summary.passed}/${summary.resultCount} passed (${Math.round(summary.passRate * 1000) / 10}%)`,
    `Average score: ${summary.averageScore}`,
    `Average progress: ${summary.averageProgressRate}`,
    ...(summary.totalEstimatedCostUsd !== undefined ? [`Estimated cost: $${formatUsd(summary.totalEstimatedCostUsd)}`] : []),
    `Output: ${summary.outputDir}`,
    ...(summary.langfuseMessage ? [`Langfuse: ${summary.langfuseMessage}`] : [])
  ].join('\n')
}

function formatTrendSummary(artifact: {
  runs: unknown[]
  outputDir: string
  deltas?: { passRate: number; averageScore: number; averageProgressRate: number }
}): string {
  return [
    `Eval trend: ${artifact.runs.length} run(s)`,
    ...(artifact.deltas
      ? [
          `Pass rate delta: ${Math.round(artifact.deltas.passRate * 1000) / 10}%`,
          `Average score delta: ${artifact.deltas.averageScore}`,
          `Average progress delta: ${artifact.deltas.averageProgressRate}`
        ]
      : []),
    `Output: ${artifact.outputDir}`
  ].join('\n')
}

function formatEvalHelp(): string {
  return [
    'q-code eval list [path...]',
    'q-code eval run [path...] [--grep PATTERN] [--tag TAG] [--exclude-tag TAG] [--difficulty easy|medium|hard] [--mode mock-agent|cli-subprocess|real-agent]',
    '                 [--max-cases N] [--max-duration-ms N] [--max-total-tokens N] [--max-cost-usd N] [--repeat N] [--concurrency N] [--report json,md,junit]',
    '                 [--allow-real-model] [--judge] [--langfuse-datasets] [--strict-langfuse]',
    'q-code eval compare <baseline-name|run-dir|run.json> <candidate-run-dir|run.json>',
    'q-code eval promote <run-dir|run.json> --as <baseline-name>',
    'q-code eval trend [--suite NAME] [--limit N] [--runs-dir DIR] [--out DIR]',
    '',
    '默认 path 为 evals/smoke；run 会写出 .q-code/evals/runs/<run-id>/run.json、cases.jsonl、report.md 和 traces/*.jsonl。'
  ].join('\n')
}

function parseReportFormats(raw: string): EvalReportFormat[] {
  const formats = raw.split(',').map((item) => item.trim()).filter(Boolean)
  const allowed = new Set(['json', 'md', 'junit'])
  for (const format of formats) {
    if (!allowed.has(format)) throw new Error(`未知 report 格式: ${format}`)
  }
  return formats as EvalReportFormat[]
}

function requireNext(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value) throw new Error(`${flag} 缺少参数`)
  return value
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 1) throw new Error(`${flag} 必须是正整数`)
  return value
}

function parseNonNegativeNumber(raw: string, flag: string): number {
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} 必须是非负数字`)
  return value
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatUsd(value: number): string {
  return (Math.round(value * 1_000_000) / 1_000_000).toFixed(6)
}
