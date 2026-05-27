/**
 * LLM-as-judge scorer：为语义质量、工具选择合理性等软指标提供 opt-in 评分。
 *
 * judge 默认不运行，只有 case 声明 `expect.judge` 且 runner/CLI 显式开启后
 * 才会调用真实模型，避免 deterministic CI 产生额外成本和非确定性。
 */
import { generateText } from 'ai'
import { createEvalJudgeModel, ensureJudgeEnvFallbacks } from './model'
import type { EvalCaseExecution, EvalCaseResult, EvalCheckResult, EvalTraceEvent } from './types'

/** judge 模型返回的结构化分数。 */
export interface EvalJudgeVerdict {
  score: number
  passed?: boolean
  reason: string
}

/** 对 case result 附加 judge check，并重新计算总分。 */
export async function applyJudgeScorer(
  execution: EvalCaseExecution,
  result: EvalCaseResult,
  options: { enabled?: boolean } = {}
): Promise<EvalCaseResult> {
  const expectation = execution.caseDef.expect.judge
  if (!expectation || expectation.enabled === false || !options.enabled) return result

  const threshold = expectation.threshold ?? 0.8
  const name = expectation.name ?? 'llm'
  let verdict: EvalJudgeVerdict
  try {
    ensureJudgeEnvFallbacks()
    const { model, modelName } = createEvalJudgeModel(expectation)
    const response = await generateText({
      model,
      system: JUDGE_SYSTEM_PROMPT,
      prompt: createJudgePrompt(execution, result),
      maxOutputTokens: expectation.maxOutputTokens ?? 800
    })
    verdict = parseJudgeResponse(response.text)
    const passed = verdict.passed ?? verdict.score >= threshold
    return appendJudgeCheck(result, {
      check: {
        name: `judge.${name}`,
        passed,
        errorType: 'final_answer_mismatch',
        message: passed ? undefined : verdict.reason
      },
      score: verdict.score,
      passed,
      reason: `${verdict.reason} (model=${modelName})`
    })
  } catch (error) {
    const reason = formatError(error)
    return appendJudgeCheck(result, {
      check: {
        name: `judge.${name}`,
        passed: false,
        errorType: 'final_answer_mismatch',
        message: `judge 失败: ${reason}`
      },
      score: 0,
      passed: false,
      reason
    })
  }
}

/** 从 judge 输出中解析 JSON 分数，供单元测试直接覆盖。 */
export function parseJudgeResponse(raw: string): EvalJudgeVerdict {
  const json = extractJson(raw)
  const parsed = JSON.parse(json) as Record<string, unknown>
  const score = clampScore(Number(parsed.score))
  const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
    ? parsed.reason.trim()
    : 'judge 未提供 reason'
  const passed = typeof parsed.passed === 'boolean' ? parsed.passed : undefined
  return {
    score,
    ...(passed !== undefined ? { passed } : {}),
    reason
  }
}

function appendJudgeCheck(
  result: EvalCaseResult,
  args: { check: EvalCheckResult; score: number; passed: boolean; reason: string }
): EvalCaseResult {
  const checks = [...result.checks, args.check]
  const passedChecks = checks.filter((check) => check.passed).length
  const score = checks.length > 0 ? round(passedChecks / checks.length) : result.score
  const firstError = checks.find((check) => !check.passed)

  return {
    ...result,
    checks,
    success: checks.every((check) => check.passed),
    score,
    judgeScore: args.score,
    judgePassed: args.passed,
    judgeReason: args.reason,
    ...(firstError?.errorType ? { errorType: firstError.errorType } : {}),
    ...(firstError?.message ? { errorMessage: firstError.message } : {})
  }
}

function createJudgePrompt(execution: EvalCaseExecution, result: EvalCaseResult): string {
  const expectation = execution.caseDef.expect.judge!
  const payload = {
    caseId: execution.caseDef.id,
    name: execution.caseDef.name,
    prompt: execution.caseDef.prompt,
    rubric: expectation.rubric,
    threshold: expectation.threshold ?? 0.8,
    deterministicChecks: result.checks,
    finalOutput: execution.finalOutput,
    trace: expectation.includeTrace ? summarizeTrace(execution.traces) : undefined
  }
  return [
    '请根据 rubric 评估 Agent 输出质量。',
    '只返回 JSON，不要使用 Markdown，不要附加解释。',
    'JSON schema: {"score": number, "passed": boolean, "reason": string}',
    'score 范围为 0 到 1，passed 表示是否达到阈值。',
    '',
    JSON.stringify(payload, null, 2)
  ].join('\n')
}

function summarizeTrace(traces: EvalTraceEvent[]): Array<Record<string, unknown>> {
  return traces.map((event) => ({
    type: event.type,
    step: event.step,
    toolName: event.toolName,
    isError: event.isError,
    durationMs: event.durationMs,
    text: truncate(event.text, 500),
    input: compactUnknown(event.input),
    output: compactUnknown(event.output)
  }))
}

function compactUnknown(value: unknown): unknown {
  if (value === undefined) return undefined
  if (typeof value === 'string') return truncate(value, 500)
  try {
    return truncate(JSON.stringify(value), 500)
  } catch {
    return truncate(String(value), 500)
  }
}

function extractJson(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1)
  throw new Error('judge 输出不是 JSON')
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) throw new Error('judge score 必须是数字')
  return Math.max(0, Math.min(1, value))
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return value
  return value.length <= max ? value : `${value.slice(0, max)}...[truncated ${value.length - max} chars]`
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const JUDGE_SYSTEM_PROMPT = `你是 q-code Agent 质量评测 judge。你只根据给定 rubric、任务提示、最终输出和可选轨迹评分。

评分要求：
- 输出必须是单个 JSON 对象。
- score 必须是 0 到 1 的数字。
- reason 用一句中文说明主要依据。
- 不要泄露或复述敏感凭据；如输入中出现疑似凭据，只描述为“敏感信息”。`
