/**
 * Eval runner：执行固定任务集、记录 trace、评分并写出 artifact。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ModelMessage } from 'ai'
import { agentLoop } from '../agent/loop'
import type { TokenUsage } from '../context/token-budget'
import { allTools } from '../tools'
import { ToolRegistry } from '../tools/registry'
import type { ToolDefinition } from '../tools/registry'
import type { UsageCost } from '../usage'
import { applyJudgeScorer } from './judge'
import { loadEvalCases } from './loader'
import { exportEvalRunToLangfuse } from './langfuse-export'
import { createEvalMockModel } from './mock-model'
import { createEvalMockTools } from './mock-tools'
import { createEvalChatModel } from './model'
import { ensureEvalRunDirs, writeEvalArtifact, writeTraceFile } from './report'
import { scoreEvalCase } from './scorers'
import { EvalTraceRecorder } from './trace-recorder'
import type {
  EvalCase,
  EvalCaseExecution,
  EvalCaseResult,
  EvalErrorType,
  EvalReportFormat,
  EvalTraceEvent,
  EvalRunArtifact,
  EvalRunOptions,
  EvalRunSummary,
  LoadedEvalCases
} from './types'

/** 执行 eval run 并写出 JSON/Markdown artifact。 */
export async function runEvalSuite(options: EvalRunOptions = {}): Promise<EvalRunArtifact> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const loaded = await loadEvalCases(options.paths, cwd)
  const selectedCases = filterEvalCases(loaded.cases, options.filters)
  const repeat = normalizeRepeat(options.repeat)
  const concurrency = normalizeConcurrency(options.concurrency)
  const reportFormats = normalizeReportFormats(options.reportFormats)
  const runId = createRunId(loaded.suiteName)
  const outputDir = resolve(options.outputDir ?? join(cwd, '.q-code', 'evals', 'runs', runId))
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const { tracesDir } = await ensureEvalRunDirs(outputDir)

  const tasks: Array<{
    caseDef: EvalCase
    repeatIndex: number
    order: number
  }> = []
  for (const caseDef of selectedCases) {
    for (let repeatIndex = 1; repeatIndex <= repeat; repeatIndex++) {
      tasks.push({ caseDef, repeatIndex, order: tasks.length })
    }
  }
  const preflightFailures = await checkPreflightLimits(options.limits, tasks.length, runId, tracesDir)
  const settledResults = preflightFailures.length > 0
    ? preflightFailures.map((result, order) => ({ order, result }))
    : await mapWithConcurrency(tasks, concurrency, async (task) => {
      const execution = await runEvalCase({
        caseDef: task.caseDef,
        runId,
        repeatIndex: task.repeatIndex,
        cwd,
        outputDir,
        tracesDir,
        allowRealModel: options.allowRealModel
      })
      const result = await applyJudgeScorer(execution, scoreEvalCase(execution), {
        enabled: options.judgeEnabled === true
      })
      return { order: task.order, result }
    })
  const results = settledResults
    .sort((left, right) => left.order - right.order)
    .map((item) => item.result)
  const limitFailures = preflightFailures.length > 0
    ? []
    : await checkPostRunLimits(options.limits, results, Date.now() - started, runId, tracesDir)
  results.push(...limitFailures)

  const finishedAt = new Date().toISOString()
  const summary = createSummary({
    loaded,
    runId,
    cwd,
    outputDir,
    startedAt,
    finishedAt,
    durationMs: Date.now() - started,
    results,
    repeat,
    concurrency,
    reportFormats,
    totalCaseCount: loaded.cases.length,
    selectedCaseCount: selectedCases.length,
    filters: options.filters,
    limits: options.limits
  })
  const artifact: EvalRunArtifact = { summary, results }

  if (options.exportLangfuse ?? true) {
    const exported = await exportEvalRunToLangfuse(artifact, {
      datasets: options.exportLangfuseDatasets === true,
      strict: options.strictLangfuse === true
    })
    artifact.summary.langfuseExported = exported.exported
    artifact.summary.langfuseMessage = exported.message
    if (exported.datasetName) artifact.summary.langfuseDatasetName = exported.datasetName
    if (exported.datasetRunName) artifact.summary.langfuseDatasetRunName = exported.datasetRunName
  }

  await mkdir(outputDir, { recursive: true })
  await writeEvalArtifact(artifact, reportFormats)
  return artifact
}

async function runEvalCase(args: {
  caseDef: EvalCase
  runId: string
  repeatIndex: number
  cwd: string
  outputDir: string
  tracesDir: string
  allowRealModel?: boolean
}): Promise<EvalCaseExecution> {
  if (args.caseDef.mode === 'cli-subprocess') return runCliSubprocessCase(args)
  if (args.caseDef.mode === 'real-agent') return runRealAgentCase(args)
  return runMockAgentCase(args)
}

async function runMockAgentCase(args: {
  caseDef: EvalCase
  runId: string
  repeatIndex: number
  cwd: string
  outputDir: string
  tracesDir: string
}): Promise<EvalCaseExecution> {
  const runCaseId = `${args.caseDef.id}#${args.repeatIndex}`
  const traceFile = join(args.tracesDir, `${sanitizeFileName(args.caseDef.id)}-${args.repeatIndex}.jsonl`)
  const recorder = new EvalTraceRecorder(args.runId, args.caseDef.id, runCaseId)
  const registry = new ToolRegistry({ cwd: args.cwd, quiet: true })
  const mock = args.caseDef.mock
  if (!mock) throw new Error(`${args.caseDef.id}: mock 配置缺失`)
  registry.register(...createEvalMockTools(mock.tools))
  const { model, callCount } = createEvalMockModel(mock.turns)
  const messages: ModelMessage[] = [{ role: 'user', content: args.caseDef.prompt }]
  const started = Date.now()
  let resultMessages: ModelMessage[] = messages
  let error: unknown

  try {
    const result = await agentLoop(model, registry, messages, args.caseDef.system ?? '', {
      quiet: true,
      modelName: 'q-code-eval-mock',
      maxSteps: args.caseDef.run?.maxSteps ?? 88,
      telemetry: ({ step }) => {
        recorder.onModelStart(step)
        return undefined
      },
      onText: (text) => recorder.onText(text),
      onToolEvent: (event) => recorder.onToolEvent(event),
      onToolResult: (event) => recorder.onToolResult(event),
      onToolProgress: (event) => recorder.onToolProgress(event),
      onUsage: (turnUsage, totalUsage) => recorder.onUsage(turnUsage, totalUsage),
      onStepUsage: (stepUsage) => recorder.onStepUsage(stepUsage)
    })
    resultMessages = result.messages
  } catch (caught) {
    error = caught
    recorder.onError(caught)
  }

  const finalOutput = extractFinalAssistantText(resultMessages)
  recorder.onFinalState(finalOutput)
  const traces = recorder.traces()
  await writeTraceFile(traceFile, traces)

  const usageCost = recorder.totalUsageCost()
  return {
    caseDef: args.caseDef,
    runId: args.runId,
    runCaseId,
    repeatIndex: args.repeatIndex,
    messages: resultMessages,
    finalOutput,
    durationMs: Date.now() - started,
    stepCount: callCount(),
    usage: recorder.totalUsage(),
    ...(usageCost ? { usageCost, estimatedCostUsd: roundCost(usageCost.cost) } : {}),
    traces,
    toolMetrics: recorder.toolMetrics(),
    traceFile,
    ...(error ? { error } : {})
  }
}

async function runRealAgentCase(args: {
  caseDef: EvalCase
  runId: string
  repeatIndex: number
  cwd: string
  outputDir: string
  tracesDir: string
  allowRealModel?: boolean
}): Promise<EvalCaseExecution> {
  if (!args.allowRealModel) {
    throw new Error(`${args.caseDef.id}: real-agent eval 需要显式传入 --allow-real-model`)
  }
  const real = args.caseDef.real
  if (!real) throw new Error(`${args.caseDef.id}: real 配置缺失`)

  const runCaseId = `${args.caseDef.id}#${args.repeatIndex}`
  const safeCaseId = sanitizeFileName(args.caseDef.id)
  const traceFile = join(args.tracesDir, `${safeCaseId}-${args.repeatIndex}.jsonl`)
  const workspaceDir = await prepareRealAgentWorkspace(args.caseDef, args.cwd, args.outputDir, safeCaseId, args.repeatIndex)
  const recorder = new EvalTraceRecorder(args.runId, args.caseDef.id, runCaseId)
  const registry = new ToolRegistry({ cwd: workspaceDir, quiet: true })
  registry.register(...selectRealAgentTools(real.tools, real.readOnlyToolsOnly ?? true))
  const messages: ModelMessage[] = [{ role: 'user', content: args.caseDef.prompt }]
  const started = Date.now()
  const abortController = new AbortController()
  const realTimeoutMs = real.timeoutMs ?? 120000
  const timeout = setTimeout(() => abortController.abort(new Error(`real-agent eval timeout ${realTimeoutMs}ms`)), realTimeoutMs)
  timeout.unref()
  let resultMessages: ModelMessage[] = messages
  let error: unknown
  const restoreEnv = applyTemporaryEnv(real.env ?? {})

  try {
    const { model, modelName } = createEvalChatModel(real)
    const result = await agentLoop(model, registry, messages, args.caseDef.system ?? '', {
      quiet: true,
      modelName,
      maxSteps: real.maxSteps ?? args.caseDef.run?.maxSteps ?? 16,
      ...(real.maxOutputTokens !== undefined ? { maxOutputTokens: real.maxOutputTokens } : {}),
      abortSignal: abortController.signal,
      telemetry: ({ step }) => {
        recorder.onModelStart(step)
        return undefined
      },
      onText: (text) => recorder.onText(text),
      onToolEvent: (event) => recorder.onToolEvent(event),
      onToolResult: (event) => recorder.onToolResult(event),
      onToolProgress: (event) => recorder.onToolProgress(event),
      onUsage: (turnUsage, totalUsage) => recorder.onUsage(turnUsage, totalUsage),
      onStepUsage: (stepUsage) => recorder.onStepUsage(stepUsage)
    })
    resultMessages = result.messages
  } catch (caught) {
    error = caught
    recorder.onError(caught)
  } finally {
    clearTimeout(timeout)
    restoreEnv()
  }

  const finalOutput = extractFinalAssistantText(resultMessages)
  recorder.onFinalState(finalOutput)
  const traces = recorder.traces()
  await writeTraceFile(traceFile, traces)
  const usageCost = recorder.totalUsageCost()

  return {
    caseDef: args.caseDef,
    runId: args.runId,
    runCaseId,
    repeatIndex: args.repeatIndex,
    messages: resultMessages,
    finalOutput,
    durationMs: Date.now() - started,
    stepCount: countModelSteps(traces),
    usage: recorder.totalUsage(),
    ...(usageCost ? { usageCost, estimatedCostUsd: roundCost(usageCost.cost) } : {}),
    traces,
    toolMetrics: recorder.toolMetrics(),
    traceFile,
    workspaceDir,
    gitDiffStatus: await detectGitDiffStatus(workspaceDir),
    ...(error ? { error } : {})
  }
}

async function runCliSubprocessCase(args: {
  caseDef: EvalCase
  runId: string
  repeatIndex: number
  cwd: string
  outputDir: string
  tracesDir: string
}): Promise<EvalCaseExecution> {
  const cli = args.caseDef.cli
  if (!cli) throw new Error(`${args.caseDef.id}: cli 配置缺失`)

  const runCaseId = `${args.caseDef.id}#${args.repeatIndex}`
  const safeCaseId = sanitizeFileName(args.caseDef.id)
  const traceFile = join(args.tracesDir, `${safeCaseId}-${args.repeatIndex}.jsonl`)
  const artifactsDir = join(args.outputDir, 'failures', `${safeCaseId}-${args.repeatIndex}`)
  await mkdir(artifactsDir, { recursive: true })
  const stdoutFile = join(artifactsDir, 'stdout.txt')
  const stderrFile = join(artifactsDir, 'stderr.txt')
  const workspaceDir = await prepareCliWorkspace(args.caseDef, args.cwd, args.outputDir, safeCaseId, args.repeatIndex)
  const started = Date.now()
  const traces: EvalTraceEvent[] = []
  let stdout = ''
  let stderr = ''
  let exitCode: number | undefined
  let error: unknown

  pushTrace(traces, args.runId, args.caseDef.id, runCaseId, {
    type: 'model_start',
    step: 1,
    metadata: {
      mode: 'cli-subprocess',
      command: cli.command,
      args: cli.args ?? [],
      workspaceDir
    }
  })

  try {
    const result = await runCliCommand({
      command: cli.command,
      args: cli.args ?? [],
      cwd: workspaceDir,
      env: {
        ...(args.caseDef.setup?.env ?? {}),
        ...(cli.env ?? {})
      },
      timeoutMs: cli.timeoutMs ?? 30000
    })
    stdout = result.stdout
    stderr = result.stderr
    exitCode = result.exitCode
  } catch (caught) {
    error = caught
    if (caught instanceof CliSubprocessError) {
      stdout = caught.stdout
      stderr = caught.stderr
      exitCode = caught.exitCode
    }
  }

  await writeFile(stdoutFile, stdout, 'utf-8')
  await writeFile(stderrFile, stderr, 'utf-8')
  const finalOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  const durationMs = Date.now() - started
  pushTrace(traces, args.runId, args.caseDef.id, runCaseId, {
    type: 'final_state',
    step: 1,
    text: finalOutput,
    durationMs,
    metadata: {
      exitCode,
      stdoutFile,
      stderrFile,
      stdoutLength: stdout.length,
      stderrLength: stderr.length
    }
  })
  if (error) {
    pushTrace(traces, args.runId, args.caseDef.id, runCaseId, {
      type: 'error',
      step: 1,
      metadata: { message: formatError(error) }
    })
  }
  await writeTraceFile(traceFile, traces)

  return {
    caseDef: args.caseDef,
    runId: args.runId,
    runCaseId,
    repeatIndex: args.repeatIndex,
    messages: [{ role: 'user', content: args.caseDef.prompt }],
    finalOutput,
    durationMs,
    stepCount: 1,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    traces,
    toolMetrics: emptyToolMetrics(),
    traceFile,
    workspaceDir,
    stdoutFile,
    stderrFile,
    ...(exitCode !== undefined ? { exitCode } : {}),
    gitDiffStatus: await detectGitDiffStatus(workspaceDir),
    ...(error ? { error } : {})
  }
}

async function prepareRealAgentWorkspace(
  caseDef: EvalCase,
  cwd: string,
  outputDir: string,
  safeCaseId: string,
  repeatIndex: number
): Promise<string> {
  if (caseDef.setup?.fixture) {
    return prepareCliWorkspace(caseDef, cwd, outputDir, safeCaseId, repeatIndex)
  }
  return cwd
}

function selectRealAgentTools(toolNames: string[] | undefined, readOnlyToolsOnly: boolean): ToolDefinition[] {
  const selectedNames = toolNames ? new Set(toolNames) : undefined
  const selected = allTools.filter((tool) => {
    if (selectedNames && !selectedNames.has(tool.name)) return false
    if (!selectedNames && readOnlyToolsOnly && tool.isReadOnly !== true) return false
    return true
  })
  if (selectedNames) {
    const found = new Set(selected.map((tool) => tool.name))
    const missing = Array.from(selectedNames).filter((name) => !found.has(name))
    if (missing.length > 0) throw new Error(`real.tools 包含未知工具: ${missing.join(', ')}`)
  }
  return selected
}

function createSummary(args: {
  loaded: LoadedEvalCases
  runId: string
  cwd: string
  outputDir: string
  startedAt: string
  finishedAt: string
  durationMs: number
  results: EvalCaseResult[]
  repeat: number
  concurrency: number
  reportFormats: EvalReportFormat[]
  totalCaseCount: number
  selectedCaseCount: number
  filters: EvalRunOptions['filters']
  limits: EvalRunOptions['limits']
}): EvalRunSummary {
  const passed = args.results.filter((result) => result.success).length
  const totalUsage = args.results.reduce<TokenUsage>(
    (sum, result) => ({
      inputTokens: sum.inputTokens + result.usage.inputTokens,
      outputTokens: sum.outputTokens + result.usage.outputTokens,
      totalTokens: sum.totalTokens + result.usage.totalTokens
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  )
  const totalUsageCost = sumUsageCosts(args.results.map((result) => result.usageCost))
  const unknownCostCases = args.results.filter((result) => !result.usageCost && result.usage.totalTokens > 0).length
  return {
    runId: args.runId,
    suiteName: args.loaded.suiteName,
    cwd: args.cwd,
    sources: args.loaded.sources,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    durationMs: args.durationMs,
    caseCount: args.totalCaseCount,
    selectedCaseCount: args.selectedCaseCount,
    resultCount: args.results.length,
    repeat: args.repeat,
    passed,
    failed: args.results.length - passed,
    passRate: args.results.length > 0 ? round(passed / args.results.length) : 0,
    passAt1: round(passAtK(args.results, 1)),
    passPowK: {
      [`pass^${args.repeat}`]: round(passPowK(args.results, args.repeat))
    },
    averageScore: average(args.results.map((result) => result.score)),
    averageProgressRate: average(args.results.map((result) => result.progressRate)),
    totalUsage,
    ...(totalUsageCost ? { totalUsageCost, totalEstimatedCostUsd: roundCost(totalUsageCost.cost) } : {}),
    unknownCostCases,
    outputDir: args.outputDir,
    concurrency: args.concurrency,
    reportFormats: args.reportFormats,
    ...(args.filters ? { filters: args.filters } : {}),
    ...(args.limits ? { limits: args.limits } : {})
  }
}

function extractFinalAssistantText(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'object' && part && 'type' in part && part.type === 'text') {
            return String((part as { text?: unknown }).text ?? '')
          }
          return ''
        })
        .join('')
    }
  }
  return ''
}

function passAtK(results: EvalCaseResult[], k: number): number {
  const byCase = groupByCase(results)
  if (byCase.size === 0) return 0
  let passed = 0
  for (const rows of byCase.values()) {
    if (rows.slice(0, k).some((row) => row.success)) passed++
  }
  return passed / byCase.size
}

function passPowK(results: EvalCaseResult[], k: number): number {
  const byCase = groupByCase(results)
  if (byCase.size === 0) return 0
  let passed = 0
  for (const rows of byCase.values()) {
    const selected = rows.slice(0, k)
    if (selected.length > 0 && selected.every((row) => row.success)) passed++
  }
  return passed / byCase.size
}

function groupByCase(results: EvalCaseResult[]): Map<string, EvalCaseResult[]> {
  const grouped = new Map<string, EvalCaseResult[]>()
  for (const result of results) {
    grouped.set(result.caseId, [...(grouped.get(result.caseId) ?? []), result])
  }
  return grouped
}

function countModelSteps(traces: EvalTraceEvent[]): number {
  const steps = new Set<number>()
  for (const trace of traces) {
    if (trace.type === 'model_start' && trace.step !== undefined) steps.add(trace.step)
  }
  return steps.size
}

function filterEvalCases(cases: EvalCase[], filters: EvalRunOptions['filters']): EvalCase[] {
  if (!filters) return cases
  const grep = filters.grep ? new RegExp(filters.grep, 'i') : undefined
  const tags = new Set(filters.tags ?? [])
  const excludeTags = new Set(filters.excludeTags ?? [])
  const difficulties = new Set(filters.difficulties ?? [])
  const modes = new Set(filters.modes ?? [])
  const selected = cases.filter((caseDef) => {
    if (grep && !grep.test(`${caseDef.id}\n${caseDef.name}\n${caseDef.prompt}`)) return false
    if (tags.size > 0 && !caseDef.tags.some((tag) => tags.has(tag))) return false
    if (excludeTags.size > 0 && caseDef.tags.some((tag) => excludeTags.has(tag))) return false
    if (difficulties.size > 0 && (!caseDef.difficulty || !difficulties.has(caseDef.difficulty))) return false
    if (modes.size > 0 && !modes.has(caseDef.mode)) return false
    return true
  })
  if (selected.length === 0) {
    throw new Error('eval 过滤条件没有匹配任何 case')
  }
  return selected
}

async function checkPreflightLimits(
  limits: EvalRunOptions['limits'],
  resultCount: number,
  runId: string,
  tracesDir: string
): Promise<EvalCaseResult[]> {
  if (!limits?.maxCases || resultCount <= limits.maxCases) return []
  return [
    await createRunLimitFailure({
      runId,
      tracesDir,
      name: 'maxCases',
      errorType: 'step_budget_exceeded',
      message: `计划运行 ${resultCount} 个结果，超过 --max-cases=${limits.maxCases}`
    })
  ]
}

async function checkPostRunLimits(
  limits: EvalRunOptions['limits'],
  results: EvalCaseResult[],
  durationMs: number,
  runId: string,
  tracesDir: string
): Promise<EvalCaseResult[]> {
  if (!limits) return []
  const failures: EvalCaseResult[] = []
  if (limits.maxDurationMs !== undefined && durationMs > limits.maxDurationMs) {
    failures.push(await createRunLimitFailure({
      runId,
      tracesDir,
      name: 'maxDurationMs',
      errorType: 'timeout',
      message: `总耗时 ${durationMs}ms 超过 --max-duration-ms=${limits.maxDurationMs}`
    }))
  }
  const totalTokens = results.reduce((sum, result) => sum + result.usage.totalTokens, 0)
  if (limits.maxTotalTokens !== undefined && totalTokens > limits.maxTotalTokens) {
    failures.push(await createRunLimitFailure({
      runId,
      tracesDir,
      name: 'maxTotalTokens',
      errorType: 'cost_budget_exceeded',
      message: `总 tokens ${totalTokens} 超过 --max-total-tokens=${limits.maxTotalTokens}`
    }))
  }
  const totalCost = sumUsageCosts(results.map((result) => result.usageCost))
  if (limits.maxCostUsd !== undefined && totalCost && totalCost.cost > limits.maxCostUsd) {
    failures.push(await createRunLimitFailure({
      runId,
      tracesDir,
      name: 'maxCostUsd',
      errorType: 'cost_budget_exceeded',
      message: `总成本 $${roundCost(totalCost.cost).toFixed(6)} 超过 --max-cost-usd=$${limits.maxCostUsd}`
    }))
  }
  return failures
}

async function createRunLimitFailure(args: {
  runId: string
  tracesDir: string
  name: string
  errorType: EvalErrorType
  message: string
}): Promise<EvalCaseResult> {
  const traceFile = join(args.tracesDir, `__run_limits__-${sanitizeFileName(args.name)}.jsonl`)
  await writeTraceFile(traceFile, [{
    ts: new Date().toISOString(),
    runId: args.runId,
    caseId: `__run_limits__.${args.name}`,
    runCaseId: `__run_limits__.${args.name}#1`,
    type: 'error',
    step: 0,
    metadata: { message: args.message, errorType: args.errorType }
  }])
  return {
    caseId: `__run_limits__.${args.name}`,
    runCaseId: `__run_limits__.${args.name}#1`,
    name: `Run limit: ${args.name}`,
    repeatIndex: 1,
    success: false,
    progressRate: 0,
    score: 0,
    tags: ['run-limit'],
    durationMs: 0,
    stepCount: 0,
    finalOutput: args.message,
    errorType: args.errorType,
    errorMessage: args.message,
    progressTimeline: [{ step: 0, score: 0 }],
    toolMetrics: emptyToolMetrics(),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    checks: [{
      name: `runLimit.${args.name}`,
      passed: false,
      errorType: args.errorType,
      message: args.message
    }],
    traceFile
  }
}

async function prepareCliWorkspace(
  caseDef: EvalCase,
  cwd: string,
  outputDir: string,
  safeCaseId: string,
  repeatIndex: number
): Promise<string> {
  const workspaceParent = join(outputDir, 'workspaces')
  await mkdir(workspaceParent, { recursive: true })
  const workspaceDir = await mkdtemp(join(workspaceParent, `${safeCaseId}-${repeatIndex}-`))
  if (!caseDef.setup?.fixture) return workspaceDir

  const fixtureDir = resolve(cwd, caseDef.setup.fixture)
  await rm(workspaceDir, { recursive: true, force: true })
  await cp(fixtureDir, workspaceDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => !source.split(/[\\/]/).includes('node_modules')
  })
  return workspaceDir
}

async function runCliCommand(args: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      shell: false,
      env: {
        ...process.env,
        ...args.env,
        Q_CODE_LANGFUSE_ENABLED: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      settled = true
      child.kill('SIGTERM')
      rejectPromise(new CliSubprocessError(`命令超时: ${args.timeoutMs}ms`, stdout, stderr, undefined))
    }, args.timeoutMs)

    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      rejectPromise(new CliSubprocessError(formatError(error), stdout, stderr, undefined))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 })
    })
  })
}

class CliSubprocessError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | undefined
  ) {
    super(message)
  }
}

async function detectGitDiffStatus(workspaceDir: string): Promise<'clean' | 'dirty' | 'unknown'> {
  const gitDir = join(workspaceDir, '.git')
  const gitConfig = join(gitDir, 'config')
  try {
    await readFile(gitConfig, 'utf-8')
  } catch {
    return 'unknown'
  }
  try {
    const result = await runCliCommand({
      command: 'git',
      args: ['status', '--porcelain'],
      cwd: workspaceDir,
      env: {},
      timeoutMs: 10000
    })
    return result.stdout.trim().length === 0 ? 'clean' : 'dirty'
  } catch {
    return 'unknown'
  }
}

function emptyToolMetrics() {
  return {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    averageLatencyMs: 0,
    distribution: {}
  }
}

function pushTrace(
  traces: EvalTraceEvent[],
  runId: string,
  caseId: string,
  runCaseId: string,
  event: Omit<EvalTraceEvent, 'ts' | 'runId' | 'caseId' | 'runCaseId'>
): void {
  traces.push({
    ts: new Date().toISOString(),
    runId,
    caseId,
    runCaseId,
    ...event
  })
}

function normalizeRepeat(repeat: number | undefined): number {
  if (!repeat || !Number.isFinite(repeat) || repeat < 1) return 1
  return Math.floor(repeat)
}

function normalizeConcurrency(concurrency: number | undefined): number {
  if (!concurrency || !Number.isFinite(concurrency) || concurrency < 1) return 1
  return Math.floor(concurrency)
}

function normalizeReportFormats(formats: EvalReportFormat[] | undefined): EvalReportFormat[] {
  const requested: EvalReportFormat[] = formats && formats.length > 0 ? formats : ['json', 'md']
  const allowed = new Set<EvalReportFormat>(['json', 'md', 'junit'])
  const unique: EvalReportFormat[] = []
  for (const format of requested) {
    if (!allowed.has(format)) continue
    if (!unique.includes(format)) unique.push(format)
  }
  return unique.length > 0 ? unique : (['json', 'md'] satisfies EvalReportFormat[])
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let index = 0
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = items[index]!
      index++
      results.push(await mapper(current))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function sumUsageCosts(costs: Array<UsageCost | undefined>): UsageCost | undefined {
  let total: UsageCost | undefined
  for (const cost of costs) {
    if (!cost) continue
    total ??= { cost: 0, baselineCost: 0, savedCost: 0 }
    total.cost += cost.cost
    total.baselineCost += cost.baselineCost
    total.savedCost += cost.savedCost
  }
  return total ? {
    cost: roundCost(total.cost),
    baselineCost: roundCost(total.baselineCost),
    savedCost: roundCost(total.savedCost)
  } : undefined
}

function createRunId(suiteName: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z')
  return `${timestamp}-${sanitizeFileName(suiteName)}-${randomUUID().slice(0, 8)}`
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'eval'
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function applyTemporaryEnv(env: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(env)) {
    previous.set(name, process.env[name])
    process.env[name] = value
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
}
