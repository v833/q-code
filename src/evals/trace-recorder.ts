/**
 * Eval trace 记录器：把 agentLoop 回调转成稳定 JSONL 事件与工具统计。
 */
import type {
  AgentStepUsage,
  AgentToolEvent,
  AgentToolProgressEvent,
  AgentToolResultEvent
} from '../agent/loop'
import type { TokenUsage } from '../context/token-budget'
import { computeCost, resolveModelPricing, type UsageCost } from '../usage'
import type {
  EvalTraceEvent,
  EvalToolDistributionItem,
  EvalToolMetrics
} from './types'

/** 收集单个 eval case 的 trace 和指标。 */
export class EvalTraceRecorder {
  private readonly events: EvalTraceEvent[] = []
  private readonly toolStarts = new Map<string, { name: string; startedAt: number }>()
  private readonly distribution = new Map<string, { calls: number; failures: number; totalLatencyMs: number }>()
  private currentStep = 0
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  private usageCost: UsageCost | undefined = { cost: 0, baselineCost: 0, savedCost: 0 }
  private unknownCostSteps = 0

  constructor(
    private readonly runId: string,
    private readonly caseId: string,
    private readonly runCaseId: string
  ) {}

  /** 标记即将进入模型步骤。 */
  onModelStart(step: number): void {
    this.currentStep = step
    this.push({ type: 'model_start', step })
  }

  /** 记录 assistant 文本增量。 */
  onText(text: string): void {
    this.push({ type: 'assistant_text', step: this.currentStep, text })
  }

  /** 记录工具进度。 */
  onToolProgress(event: AgentToolProgressEvent): void {
    this.push({
      type: 'tool_progress',
      step: this.currentStep,
      toolName: event.name,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.text ? { text: event.text } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {})
    })
  }

  /** 记录工具 start/done 生命周期。 */
  onToolEvent(event: AgentToolEvent): void {
    if (event.phase === 'start') {
      this.toolStarts.set(toolKey(event), { name: event.name, startedAt: Date.now() })
      const item = this.ensureToolStats(event.name)
      item.calls++
      this.push({
        type: 'tool_call',
        step: this.currentStep,
        toolName: event.name,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.input !== undefined ? { input: event.input } : {})
      })
      return
    }

    // `agentLoop` 紧接着会触发 onToolResult，那里包含 output、耗时和错误状态。
    // 这里不再写一条简化版 tool_result，避免 trace 中出现重复工具结果。
  }

  /** 记录工具最终 output，并计算延迟和失败率。 */
  onToolResult(event: AgentToolResultEvent): void {
    const key = toolKey(event)
    const started = this.toolStarts.get(key)
    const durationMs = started ? Date.now() - started.startedAt : undefined
    const item = this.ensureToolStats(event.name)
    if (event.isError) item.failures++
    if (durationMs !== undefined) item.totalLatencyMs += durationMs
    this.toolStarts.delete(key)

    this.push({
      type: 'tool_result',
      step: this.currentStep,
      toolName: event.name,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.input !== undefined ? { input: event.input } : {}),
      output: event.output,
      ...(event.resultLength !== undefined ? { resultLength: event.resultLength } : {}),
      isError: event.isError === true,
      ...(durationMs !== undefined ? { durationMs } : {})
    })
  }

  /** 记录本轮累计 usage。 */
  onUsage(turnUsage: TokenUsage, totalUsage: TokenUsage): void {
    this.usage = totalUsage
    this.push({
      type: 'usage',
      step: this.currentStep,
      usage: turnUsage,
      metadata: { totalUsage }
    })
  }

  /** 记录单步 rich usage。 */
  onStepUsage(stepUsage: AgentStepUsage): void {
    const cost = estimateStepCost(stepUsage)
    if (cost) {
      this.usageCost!.cost += cost.cost
      this.usageCost!.baselineCost += cost.baselineCost
      this.usageCost!.savedCost += cost.savedCost
    } else {
      this.unknownCostSteps++
    }
    this.push({
      type: 'step_usage',
      step: this.currentStep,
      usage: stepUsage.usage,
      metadata: {
        model: stepUsage.model,
        discarded: stepUsage.discarded,
        ...(cost ? { cost } : {})
      }
    })
  }

  /** 记录错误。 */
  onError(error: unknown): void {
    this.push({
      type: 'error',
      step: this.currentStep,
      metadata: { message: formatError(error) }
    })
  }

  /** 记录终态。 */
  onFinalState(finalOutput: string): void {
    this.push({
      type: 'final_state',
      step: this.currentStep,
      text: finalOutput
    })
  }

  /** 返回所有 trace 事件。 */
  traces(): EvalTraceEvent[] {
    return this.events.slice()
  }

  /** 返回累计 usage。 */
  totalUsage(): TokenUsage {
    return this.usage
  }

  /** 返回按步骤累加的估算成本；全部步骤缺少价格表时返回 undefined。 */
  totalUsageCost(): UsageCost | undefined {
    if (this.unknownCostSteps > 0 && this.usageCost && this.usageCost.cost === 0 && this.usageCost.baselineCost === 0) {
      return undefined
    }
    return this.usageCost ? { ...this.usageCost } : undefined
  }

  /** 计算工具指标。 */
  toolMetrics(): EvalToolMetrics {
    const distribution: Record<string, EvalToolDistributionItem> = {}
    let totalCalls = 0
    let failedCalls = 0
    let totalLatency = 0

    for (const [name, item] of this.distribution) {
      totalCalls += item.calls
      failedCalls += item.failures
      totalLatency += item.totalLatencyMs
      distribution[name] = {
        calls: item.calls,
        failures: item.failures,
        averageLatencyMs: item.calls > 0 ? Math.round(item.totalLatencyMs / item.calls) : 0
      }
    }

    return {
      totalCalls,
      successfulCalls: totalCalls - failedCalls,
      failedCalls,
      averageLatencyMs: totalCalls > 0 ? Math.round(totalLatency / totalCalls) : 0,
      distribution
    }
  }

  private push(event: Omit<EvalTraceEvent, 'ts' | 'runId' | 'caseId' | 'runCaseId'>): void {
    this.events.push({
      ts: new Date().toISOString(),
      runId: this.runId,
      caseId: this.caseId,
      runCaseId: this.runCaseId,
      ...event
    })
  }

  private ensureToolStats(name: string): { calls: number; failures: number; totalLatencyMs: number } {
    const existing = this.distribution.get(name)
    if (existing) return existing
    const created = { calls: 0, failures: 0, totalLatencyMs: 0 }
    this.distribution.set(name, created)
    return created
  }
}

function estimateStepCost(stepUsage: AgentStepUsage): UsageCost | undefined {
  const resolved = resolveModelPricing(stepUsage.model)
  return computeCost(stepUsage.usage, resolved?.pricing)
}

function toolKey(event: { name: string; toolCallId?: string }): string {
  return event.toolCallId ?? event.name
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
