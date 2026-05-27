/**
 * Agent 评测子系统的稳定数据结构。
 *
 * 这些类型同时约束文件化 eval case、运行时 trace、评分结果和报告 artifact。
 * 本地 `.q-code/evals` artifact 是真源；外部 Langfuse 仅作为可选增强后端。
 */
import type { ModelMessage } from 'ai'
import type { TokenUsage } from '../context/token-budget'
import type { NormalizedUsage, UsageCost } from '../usage'

/** Eval case 难度，用于报告分组和回归对比。 */
export type EvalDifficulty = 'easy' | 'medium' | 'hard'

/** 当前支持的 eval 执行模式。 */
export type EvalMode = 'mock-agent' | 'cli-subprocess' | 'real-agent'

/** 可写出的报告格式。 */
export type EvalReportFormat = 'json' | 'md' | 'junit'

/** Eval case 过滤条件。 */
export interface EvalCaseFilter {
  grep?: string
  tags?: string[]
  excludeTags?: string[]
  difficulties?: EvalDifficulty[]
  modes?: EvalMode[]
}

/** Eval run 级别资源闸门。 */
export interface EvalRunLimits {
  maxCases?: number
  maxDurationMs?: number
  maxTotalTokens?: number
  maxCostUsd?: number
}

/** 失败归因类型，报告里用它解释退化来源。 */
export type EvalErrorType =
  | 'final_answer_mismatch'
  | 'wrong_tool'
  | 'invalid_tool_args'
  | 'tool_execution_error'
  | 'step_budget_exceeded'
  | 'cost_budget_exceeded'
  | 'timeout'
  | 'policy_violation'
  | 'wrong_file_side_effect'

/** 工具轨迹匹配模式。 */
export type EvalTrajectoryMode = 'strict' | 'unordered' | 'subset'

/** Mock 模型单步脚本。 */
export interface EvalMockTurn {
  text?: string
  tools?: Array<{ name: string; input?: unknown; toolCallId?: string }>
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' | 'other' | 'unknown'
  usage?: TokenUsage
}

/** Mock 工具定义，供确定性 eval 使用。 */
export interface EvalMockToolSpec {
  name: string
  output?: unknown
  error?: string
  delayMs?: number
}

/** Eval case 的 mock-agent 配置。 */
export interface EvalMockAgentSpec {
  turns: EvalMockTurn[]
  tools?: EvalMockToolSpec[]
}

/** CLI 子进程 eval 的隔离工作区准备方式。 */
export interface EvalSetupSpec {
  fixture?: string
  env?: Record<string, string>
}

/** CLI 子进程 eval 配置。 */
export interface EvalCliSubprocessSpec {
  command: string
  args?: string[]
  timeoutMs?: number
  env?: Record<string, string>
  expectedExitCode?: number
}

/** 真实模型 eval 配置；必须通过 CLI/runner 显式 opt-in 才会执行。 */
export interface EvalRealAgentSpec {
  model?: string
  baseUrlEnv?: string
  apiKeyEnv?: string
  modelEnv?: string
  maxSteps?: number
  maxOutputTokens?: number
  timeoutMs?: number
  tools?: string[]
  readOnlyToolsOnly?: boolean
  env?: Record<string, string>
}

/** 执行期保护，不参与评分；评分预算放在 expect.budgets。 */
export interface EvalRunGuardSpec {
  maxSteps?: number
}


/** 最终回答断言。 */
export interface EvalFinalExpectation {
  contains?: string[]
  notContains?: string[]
  regex?: string[]
}

/** 工具轨迹断言。 */
export interface EvalTrajectoryExpectation {
  mode?: EvalTrajectoryMode
  expectedTools?: string[]
  requiredTools?: string[]
  forbiddenTools?: string[]
  maxExtraTools?: number
  expectedSteps?: Array<{
    step: number
    tool?: string
    tools?: string[]
  }>
}

/** 预算断言。 */
export interface EvalBudgetExpectation {
  maxSteps?: number
  maxToolCalls?: number
  maxDurationMs?: number
  maxTotalTokens?: number
  maxCostUsd?: number
}

/** 责任/安全断言，用于策略、泄密和工具输入边界检测。 */
export interface EvalSafetyExpectation {
  forbiddenOutputPatterns?: string[]
  forbiddenToolInputPatterns?: string[]
  forbiddenToolOutputPatterns?: string[]
  forbiddenPaths?: string[]
  forbidSecrets?: boolean
}

/** 文件内容断言。 */
export interface EvalFileExpectation {
  path: string
  exists?: boolean
  contains?: string[]
  notContains?: string[]
  regex?: string[]
}

/** 副作用断言，供 cli/worktree eval 复用。 */
export interface EvalSideEffectExpectation {
  gitDiff?: 'clean' | 'dirty' | 'any'
  files?: EvalFileExpectation[]
}

/** LLM-as-judge 断言，适合评价语义质量、工具选择理由等非确定性指标。 */
export interface EvalJudgeExpectation {
  enabled?: boolean
  name?: string
  rubric: string
  threshold?: number
  model?: string
  baseUrlEnv?: string
  apiKeyEnv?: string
  modelEnv?: string
  maxOutputTokens?: number
  includeTrace?: boolean
}

/** Eval case 的所有期望。 */
export interface EvalExpectations {
  final?: EvalFinalExpectation
  trajectory?: EvalTrajectoryExpectation
  budgets?: EvalBudgetExpectation
  safety?: EvalSafetyExpectation
  sideEffects?: EvalSideEffectExpectation
  judge?: EvalJudgeExpectation
  checkpoints?: string[]
}

/** 单个可执行 eval case。 */
export interface EvalCase {
  id: string
  name: string
  tags: string[]
  difficulty?: EvalDifficulty
  mode: EvalMode
  prompt: string
  system?: string
  setup?: EvalSetupSpec
  run?: EvalRunGuardSpec
  mock?: EvalMockAgentSpec
  cli?: EvalCliSubprocessSpec
  real?: EvalRealAgentSpec
  expect: EvalExpectations
}

/** 文件化 suite，loader 会展开为多个 EvalCase。 */
export interface EvalSuiteFile {
  suite?: string
  name?: string
  cases: EvalCase[]
}

/** Trace 事件类型。 */
export type EvalTraceEventType =
  | 'model_start'
  | 'assistant_text'
  | 'tool_call'
  | 'tool_result'
  | 'tool_progress'
  | 'usage'
  | 'step_usage'
  | 'error'
  | 'final_state'

/** 单条 eval trace 事件。 */
export interface EvalTraceEvent {
  ts: string
  caseId: string
  runCaseId: string
  runId: string
  type: EvalTraceEventType
  step?: number
  text?: string
  toolName?: string
  toolCallId?: string
  input?: unknown
  output?: unknown
  resultLength?: number
  isError?: boolean
  durationMs?: number
  usage?: TokenUsage | NormalizedUsage
  metadata?: Record<string, unknown>
}

/** 单个工具的统计。 */
export interface EvalToolDistributionItem {
  calls: number
  failures: number
  averageLatencyMs: number
}

/** 工具执行统计。 */
export interface EvalToolMetrics {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  averageLatencyMs: number
  distribution: Record<string, EvalToolDistributionItem>
}

/** 单项 scorer 的结果。 */
export interface EvalCheckResult {
  name: string
  passed: boolean
  errorType?: EvalErrorType
  message?: string
}

/** 进度曲线，用于定位任务推进发生在哪一步。 */
export interface EvalProgressPoint {
  step: number
  score: number
}

/** 单个 case 的运行结果。 */
export interface EvalCaseResult {
  caseId: string
  runCaseId: string
  name: string
  repeatIndex: number
  success: boolean
  progressRate: number
  score: number
  difficulty?: EvalDifficulty
  tags: string[]
  durationMs: number
  stepCount: number
  finalOutput: string
  errorType?: EvalErrorType
  errorMessage?: string
  progressTimeline: EvalProgressPoint[]
  toolMetrics: EvalToolMetrics
  usage: TokenUsage
  usageCost?: UsageCost
  estimatedCostUsd?: number
  judgeScore?: number
  judgePassed?: boolean
  judgeReason?: string
  langfuseTraceId?: string
  langfuseDatasetItemId?: string
  langfuseDatasetRunItemId?: string
  langfuseScoreIds?: string[]
  checks: EvalCheckResult[]
  traceFile: string
  workspaceDir?: string
  stdoutFile?: string
  stderrFile?: string
  exitCode?: number
}

/** Eval run 汇总。 */
export interface EvalRunSummary {
  runId: string
  suiteName: string
  cwd: string
  sources: string[]
  startedAt: string
  finishedAt: string
  durationMs: number
  caseCount: number
  selectedCaseCount: number
  resultCount: number
  repeat: number
  passed: number
  failed: number
  passRate: number
  passAt1: number
  passPowK: Record<string, number>
  averageScore: number
  averageProgressRate: number
  totalUsage: TokenUsage
  totalUsageCost?: UsageCost
  totalEstimatedCostUsd?: number
  unknownCostCases: number
  outputDir: string
  concurrency: number
  reportFormats: EvalReportFormat[]
  filters?: EvalCaseFilter
  limits?: EvalRunLimits
  langfuseExported?: boolean
  langfuseMessage?: string
  langfuseDatasetName?: string
  langfuseDatasetRunName?: string
  trendFile?: string
  trendReportFile?: string
}

/** Eval run 完整 artifact。 */
export interface EvalRunArtifact {
  summary: EvalRunSummary
  results: EvalCaseResult[]
}

/** Runner 选项。 */
export interface EvalRunOptions {
  cwd?: string
  paths?: string[]
  outputDir?: string
  reportFormats?: EvalReportFormat[]
  repeat?: number
  concurrency?: number
  filters?: EvalCaseFilter
  limits?: EvalRunLimits
  exportLangfuse?: boolean
  exportLangfuseDatasets?: boolean
  allowRealModel?: boolean
  judgeEnabled?: boolean
  strictLangfuse?: boolean
}

/** Loader 返回的 case 和来源信息。 */
export interface LoadedEvalCases {
  suiteName: string
  cases: EvalCase[]
  sources: string[]
}

/** 单个 case 执行的原始材料，供 scorer 使用。 */
export interface EvalCaseExecution {
  caseDef: EvalCase
  runId: string
  runCaseId: string
  repeatIndex: number
  messages: ModelMessage[]
  finalOutput: string
  durationMs: number
  stepCount: number
  usage: TokenUsage
  usageCost?: UsageCost
  estimatedCostUsd?: number
  traces: EvalTraceEvent[]
  toolMetrics: EvalToolMetrics
  traceFile: string
  workspaceDir?: string
  stdoutFile?: string
  stderrFile?: string
  exitCode?: number
  gitDiffStatus?: 'clean' | 'dirty' | 'unknown'
  error?: unknown
}

/** 趋势看板单次 run 快照。 */
export interface EvalTrendRunPoint {
  runId: string
  suiteName: string
  startedAt: string
  finishedAt: string
  durationMs: number
  resultCount: number
  passed: number
  failed: number
  passRate: number
  averageScore: number
  averageProgressRate: number
  totalTokens: number
  totalEstimatedCostUsd?: number
  outputDir: string
}

/** 趋势看板 artifact。 */
export interface EvalTrendArtifact {
  generatedAt: string
  cwd: string
  runsDir: string
  outputDir: string
  suiteName?: string
  limit: number
  runs: EvalTrendRunPoint[]
  deltas?: {
    passRate: number
    averageScore: number
    averageProgressRate: number
    totalTokens: number
    totalEstimatedCostUsd?: number
  }
}
