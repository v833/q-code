/**
 * Optional Langfuse/OpenTelemetry exporter.
 *
 * Langfuse is intentionally an add-on: q-code keeps local audit/eval artifacts
 * as the source of truth and only exports compact, privacy-preserving telemetry
 * when explicitly enabled.
 */
import { createHash } from 'node:crypto'
import type { AttributeValue } from '@opentelemetry/api'
import { SpanStatusCode } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import {
  getLangfuseTracer,
  propagateAttributes,
  startActiveObservation,
  type LangfuseAgent,
  type LangfuseTool
} from '@langfuse/tracing'
import type { TelemetrySettings } from 'ai'
import type {
  AgentModelWaitEvent,
  AgentStepMetricEvent,
  AgentStepUsage,
  AgentToolEvent,
  AgentToolProgressEvent,
  AgentToolResultEvent
} from '../agent/loop'
import type { TokenUsage } from '../context/token-budget'
import type { HookAgentContext } from '../hooks'
import { isTrueEnv } from '../utils/env'

const DEFAULT_LANGFUSE_BASE_URL = 'https://cloud.langfuse.com'
const DEFAULT_FLUSH_AT = 20
const DEFAULT_FLUSH_INTERVAL_SECONDS = 5
const DEFAULT_TIMEOUT_SECONDS = 5
const MAX_METADATA_VALUE_LENGTH = 200

export interface LangfuseConfig {
  enabled: boolean
  publicKey?: string
  secretKey?: string
  baseUrl: string
  recordIO: boolean
  sampleRate: number
  environment?: string
  release?: string
  flushAt: number
  flushIntervalSeconds: number
  timeoutSeconds: number
}

export interface LangfuseTurnContext {
  sessionId: string
  cwd: string
  modelName: string
  userQuery: string
  agent: HookAgentContext
}

export interface LangfuseTurnObserver {
  readonly enabled: boolean
  readonly traceId?: string
  telemetryForStep(step: number): TelemetrySettings | undefined
  onText(text: string): void
  onToolProgress(event: AgentToolProgressEvent): void
  onToolEvent(event: AgentToolEvent): void
  onToolResult(event: AgentToolResultEvent): void
  onUsage(turnUsage: TokenUsage, totalUsage: TokenUsage): void
  onStepUsage(stepUsage: AgentStepUsage): void
  onStepMetrics(event: AgentStepMetricEvent): void
  onModelWait(event: AgentModelWaitEvent): void
  end(args?: { status?: 'completed' | 'error'; error?: unknown }): void
}

let sdk: NodeSDK | undefined
let configCache: LangfuseConfig | undefined

export function getLangfuseConfig(env: NodeJS.ProcessEnv = process.env): LangfuseConfig {
  if (env !== process.env) return buildLangfuseConfig(env)
  configCache ??= buildLangfuseConfig(env)
  return configCache
}

function buildLangfuseConfig(env: NodeJS.ProcessEnv): LangfuseConfig {
  return {
    enabled: isTrueEnv(env.Q_CODE_LANGFUSE_ENABLED),
    ...(hasText(env.LANGFUSE_PUBLIC_KEY) ? { publicKey: env.LANGFUSE_PUBLIC_KEY.trim() } : {}),
    ...(hasText(env.LANGFUSE_SECRET_KEY) ? { secretKey: env.LANGFUSE_SECRET_KEY.trim() } : {}),
    baseUrl: hasText(env.LANGFUSE_BASE_URL)
      ? env.LANGFUSE_BASE_URL.trim()
      : DEFAULT_LANGFUSE_BASE_URL,
    recordIO: isTrueEnv(env.Q_CODE_LANGFUSE_RECORD_IO),
    sampleRate: parseSampleRate(env.Q_CODE_LANGFUSE_SAMPLE_RATE),
    ...(hasText(env.Q_CODE_LANGFUSE_ENVIRONMENT)
      ? { environment: env.Q_CODE_LANGFUSE_ENVIRONMENT.trim() }
      : {}),
    ...(hasText(env.Q_CODE_LANGFUSE_RELEASE)
      ? { release: env.Q_CODE_LANGFUSE_RELEASE.trim() }
      : {}),
    flushAt: parsePositiveInt(env.Q_CODE_LANGFUSE_FLUSH_AT, DEFAULT_FLUSH_AT),
    flushIntervalSeconds: parsePositiveInt(
      env.Q_CODE_LANGFUSE_FLUSH_INTERVAL_SECONDS,
      DEFAULT_FLUSH_INTERVAL_SECONDS
    ),
    timeoutSeconds: parsePositiveInt(env.Q_CODE_LANGFUSE_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS)
  }
}

export function resetLangfuseForTests(): void {
  sdk = undefined
  configCache = undefined
}

export function initializeLangfuse(): { enabled: boolean; message: string } {
  const config = getLangfuseConfig()
  if (!config.enabled) return { enabled: false, message: 'disabled' }
  if (!config.publicKey || !config.secretKey) {
    return {
      enabled: false,
      message: 'Q_CODE_LANGFUSE_ENABLED=true but LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY missing'
    }
  }
  if (sdk) return { enabled: true, message: `exporting to ${config.baseUrl}` }

  sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        flushAt: config.flushAt,
        flushInterval: config.flushIntervalSeconds,
        timeout: config.timeoutSeconds,
        ...(config.environment ? { environment: config.environment } : {}),
        ...(config.release ? { release: config.release } : {}),
        mask: ({ data }) => (config.recordIO ? data : maskLangfuseData(data))
      })
    ]
  })
  sdk.start()
  return { enabled: true, message: `exporting to ${config.baseUrl}` }
}

export async function shutdownLangfuse(): Promise<void> {
  if (!sdk) return
  await sdk.shutdown()
  sdk = undefined
}

export function createNoopLangfuseTurnObserver(): LangfuseTurnObserver {
  return {
    enabled: false,
    telemetryForStep: () => undefined,
    onText: () => {},
    onToolProgress: () => {},
    onToolEvent: () => {},
    onToolResult: () => {},
    onUsage: () => {},
    onStepUsage: () => {},
    onStepMetrics: () => {},
    onModelWait: () => {},
    end: () => {}
  }
}

export async function observeLangfuseTurn<T>(
  args: LangfuseTurnContext,
  fn: (observer: LangfuseTurnObserver) => Promise<T>
): Promise<T> {
  const config = getLangfuseConfig()
  if (!config.enabled || !sdk || shouldSkipSample(config.sampleRate)) {
    return fn(createNoopLangfuseTurnObserver())
  }

  let originalError: unknown
  let observer: ActiveLangfuseTurnObserver | undefined
  try {
    const result = await startActiveObservation(
      'q-code.turn',
      async (turn) => {
        const activeObserver = new ActiveLangfuseTurnObserver(config, turn, args)
        observer = activeObserver
        activeObserver.initialize()
        return propagateAttributes(createPropagationAttributes(args), async () => {
          try {
            return await fn(activeObserver)
          } catch (error) {
            originalError = error
            throw config.recordIO ? error : new Error('q-code turn failed')
          }
        })
      },
      { asType: 'agent', endOnExit: false }
    )
    observer?.end({ status: 'completed' })
    return result
  } catch (error) {
    observer?.end({ status: 'error', error: originalError ?? error })
    throw originalError ?? error
  }
}

function createPropagationAttributes(args: LangfuseTurnContext) {
  return {
    sessionId: shortMetadataValue(args.sessionId),
    traceName: 'q-code.turn',
    tags: ['q-code', `agent:${args.agent.kind}`],
    metadata: {
      cwd: shortMetadataValue(args.cwd),
      model: shortMetadataValue(args.modelName),
      agentKind: shortMetadataValue(args.agent.kind)
    }
  }
}

function createTurnAttributes(config: LangfuseConfig, args: LangfuseTurnContext) {
  return {
    ...(config.recordIO ? { input: args.userQuery } : {}),
    metadata: {
      cwd: args.cwd,
      model: args.modelName,
      agentKind: args.agent.kind,
      ...(agentMetadata(args.agent) ?? {}),
      userQuery: summarizeText(args.userQuery)
    }
  }
}

class ActiveLangfuseTurnObserver implements LangfuseTurnObserver {
  readonly enabled = true
  readonly traceId: string
  private activeStep: LangfuseAgent | undefined
  private readonly toolSpans = new Map<string, { span: LangfuseTool; startedAt: number }>()
  private textChars = 0
  private toolCallCount = 0
  private toolErrorCount = 0
  private stepCount = 0
  private readonly stepWaitLevels = new Map<number, AgentModelWaitEvent['level']>()
  private ended = false

  constructor(
    private readonly config: LangfuseConfig,
    private readonly turn: LangfuseAgent,
    private readonly context: LangfuseTurnContext
  ) {
    this.traceId = turn.traceId
  }

  initialize(): void {
    this.turn.updateOtelSpanAttributes(createTurnAttributes(this.config, this.context))
  }

  telemetryForStep(step: number): TelemetrySettings {
    this.ensureStep(step)
    return {
      isEnabled: true,
      recordInputs: this.config.recordIO,
      recordOutputs: this.config.recordIO,
      functionId: 'q-code.agent-loop',
      tracer: getLangfuseTracer(),
      metadata: compactAttributes({
        sessionId: this.context.sessionId,
        step,
        model: this.context.modelName,
        cwd: this.context.cwd,
        agentKind: this.context.agent.kind,
        traceId: this.traceId
      })
    }
  }

  onText(text: string): void {
    this.textChars += text.length
  }

  onToolProgress(event: AgentToolProgressEvent): void {
    if (event.type !== 'shell_output' || !event.text) return
    const span = event.toolCallId ? this.toolSpans.get(event.toolCallId)?.span : undefined
    span?.updateOtelSpanAttributes({
      metadata: {
        progressType: event.type,
        progressText: summarizeText(event.text)
      }
    })
  }

  onToolEvent(event: AgentToolEvent): void {
    if (event.phase === 'start') {
      this.toolCallCount++
      const span = this.turn.startObservation(
        `tool.${event.name}`,
        {
          ...(this.config.recordIO && event.input !== undefined ? { input: event.input } : {}),
          metadata: {
            toolName: event.name,
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
            ...(event.input !== undefined ? { input: createLangfuseSummaryPayload(event.input) } : {})
          }
        },
        { asType: 'tool' }
      )
      if (event.toolCallId) this.toolSpans.set(event.toolCallId, { span, startedAt: Date.now() })
      return
    }

    const record = event.toolCallId ? this.toolSpans.get(event.toolCallId) : undefined
    if (!record) return
    record.span.updateOtelSpanAttributes({
      level: event.isError ? 'ERROR' : 'DEFAULT',
      statusMessage: event.isError ? 'tool returned error' : undefined,
      metadata: {
        toolName: event.name,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.resultLength !== undefined ? { resultLength: event.resultLength } : {}),
        durationMs: Date.now() - record.startedAt,
        isError: event.isError === true
      }
    })
  }

  onToolResult(event: AgentToolResultEvent): void {
    if (event.isError) this.toolErrorCount++
    const record = event.toolCallId ? this.toolSpans.get(event.toolCallId) : undefined
    if (!record) return
    record.span.updateOtelSpanAttributes({
      ...(this.config.recordIO ? { output: event.output } : {}),
      level: event.isError ? 'ERROR' : 'DEFAULT',
      statusMessage: event.isError ? 'tool returned error' : undefined,
      metadata: {
        toolName: event.name,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.resultLength !== undefined ? { resultLength: event.resultLength } : {}),
        output: createLangfuseSummaryPayload(event.output),
        durationMs: Date.now() - record.startedAt,
        isError: event.isError === true
      }
    })
    record.span.end()
    if (event.toolCallId) this.toolSpans.delete(event.toolCallId)
  }

  onUsage(turnUsage: TokenUsage, totalUsage: TokenUsage): void {
    this.turn.updateOtelSpanAttributes({
      metadata: {
        turnInputTokens: turnUsage.inputTokens,
        turnOutputTokens: turnUsage.outputTokens,
        turnTotalTokens: turnUsage.totalTokens,
        totalInputTokens: totalUsage.inputTokens,
        totalOutputTokens: totalUsage.outputTokens,
        totalTokens: totalUsage.totalTokens
      }
    })
  }

  onStepUsage(stepUsage: AgentStepUsage): void {
    if (!this.activeStep) return
    this.activeStep.updateOtelSpanAttributes({
      metadata: {
        model: stepUsage.model,
        discarded: stepUsage.discarded,
        inputTokens: stepUsage.usage.inputTokens,
        outputTokens: stepUsage.usage.outputTokens,
        totalTokens: stepUsage.usage.totalTokens,
        ...stepMetricMetadata(stepUsage.metrics)
      }
    })
  }

  onStepMetrics(event: AgentStepMetricEvent): void {
    this.ensureStep(event.step)
    this.activeStep?.updateOtelSpanAttributes({
      level: 'DEFAULT',
      statusMessage: event.finishReason ? `finished:${event.finishReason}` : 'completed',
      metadata: {
        step: event.step,
        model: event.model,
        hasToolCall: event.hasToolCall,
        ...(event.finishReason ? { finishReason: event.finishReason } : {}),
        ...(this.stepWaitLevels.has(event.step)
          ? { modelWaitMaxLevel: this.stepWaitLevels.get(event.step) }
          : {}),
        ...stepMetricMetadata(event.metrics)
      }
    })
  }

  onModelWait(event: AgentModelWaitEvent): void {
    this.ensureStep(event.step)
    this.stepWaitLevels.set(event.step, maxModelWaitLevel(this.stepWaitLevels.get(event.step), event.level))
    this.activeStep?.updateOtelSpanAttributes({
      level: event.level === 'stalled' ? 'WARNING' : 'DEFAULT',
      statusMessage: event.message,
      metadata: {
        modelWaitLevel: event.level,
        modelWaitElapsedMs: event.elapsedMs,
        modelWaitThresholdMs: event.thresholdMs
      }
    })
  }

  end(args: { status?: 'completed' | 'error'; error?: unknown } = {}): void {
    if (this.ended) return
    this.ended = true

    for (const [toolCallId, record] of this.toolSpans) {
      record.span.updateOtelSpanAttributes({
        level: 'WARNING',
        statusMessage: 'tool span closed by turn end',
        metadata: {
          toolCallId,
          durationMs: Date.now() - record.startedAt
        }
      })
      record.span.end()
    }
    this.toolSpans.clear()
    this.activeStep?.end()
    this.activeStep = undefined

    const errorText = args.error ? formatError(args.error) : undefined
    if (errorText) {
      if (this.config.recordIO) this.turn.otelSpan.recordException(errorText)
      this.turn.otelSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: this.config.recordIO ? errorText : 'q-code turn failed'
      })
    }
    this.turn.updateOtelSpanAttributes({
      level: args.status === 'error' ? 'ERROR' : 'DEFAULT',
      statusMessage: args.status ?? 'completed',
      metadata: {
        textChars: this.textChars,
        toolCallCount: this.toolCallCount,
        toolErrorCount: this.toolErrorCount,
        stepCount: this.stepCount,
        ...(errorText ? { error: summarizeText(errorText) } : {})
      }
    })
    this.turn.end()
  }

  private ensureStep(step: number): void {
    if (this.stepCount === step && this.activeStep) return
    this.activeStep?.end()
    this.stepCount = step
    this.activeStep = this.turn.startObservation(
      `agent.step.${step}`,
      {
        metadata: {
          step,
          model: this.context.modelName,
          agentKind: this.context.agent.kind
        }
      },
      { asType: 'agent' }
    )
  }
}

function agentMetadata(agent: HookAgentContext): Record<string, string> | undefined {
  if (agent.kind === 'main') return undefined
  const metadata: Record<string, string> = {}
  if ('agentType' in agent && agent.agentType) metadata.agentType = agent.agentType
  if ('agentName' in agent && agent.agentName) metadata.agentName = agent.agentName
  if ('teamName' in agent && agent.teamName) metadata.teamName = agent.teamName
  return metadata
}

function stepMetricMetadata(metrics: AgentStepMetricEvent['metrics'] | undefined): Record<string, unknown> {
  if (!metrics) return {}
  return {
    ttftMs: metrics.ttftMs,
    elapsedMs: metrics.elapsedMs,
    tokensPerSecond: metrics.tokensPerSecond,
    outputTokens: metrics.outputTokens
  }
}

function maxModelWaitLevel(
  current: AgentModelWaitEvent['level'] | undefined,
  next: AgentModelWaitEvent['level']
): AgentModelWaitEvent['level'] {
  const rank: Record<AgentModelWaitEvent['level'], number> = {
    waiting: 1,
    slow: 2,
    stalled: 3
  }
  if (!current) return next
  return rank[next] > rank[current] ? next : current
}

function maskLangfuseData(value: unknown): unknown {
  if (typeof value === 'string') return summarizeText(value)
  if (Array.isArray(value)) return value.map((item) => maskLangfuseData(item))
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (key.endsWith('.input') || key.endsWith('.output') || key === 'ai.prompt') {
      result[key] = createLangfuseSummaryPayload(inner)
    } else {
      result[key] = maskLangfuseData(inner)
    }
  }
  return result
}

export function createLangfuseSummaryPayload(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : safeStringify(value)
  return summarizeText(text)
}

function summarizeText(text: string): Record<string, unknown> {
  return {
    chars: text.length,
    sha256: createHash('sha256').update(text).digest('hex')
  }
}

function compactAttributes(values: Record<string, unknown>): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {}
  for (const [key, value] of Object.entries(values)) {
    const attr = toAttributeValue(value)
    if (attr !== undefined) result[key] = attr
  }
  return result
}

function toAttributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string') return shortMetadataValue(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value === undefined || value === null) return undefined
  return shortMetadataValue(safeStringify(value))
}

function shortMetadataValue(value: string): string {
  return value.length <= MAX_METADATA_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_METADATA_VALUE_LENGTH - 1)}…`
}

function shouldSkipSample(sampleRate: number): boolean {
  return sampleRate < 1 && Math.random() > sampleRate
}

function parseSampleRate(raw: string | undefined): number {
  if (!hasText(raw)) return 1
  const value = Number(raw.trim())
  if (!Number.isFinite(value)) return 1
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!hasText(raw)) return fallback
  const value = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
