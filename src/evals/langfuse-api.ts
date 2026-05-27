/**
 * Langfuse Public API 轻量客户端。
 *
 * SDK v5 当前主要覆盖 tracing/OTel；dataset run items 与 scores 使用
 * Public API 补齐。所有调用都只返回 id/计数，不记录 Basic Auth 明文。
 */
import { createHash } from 'node:crypto'
import type { LangfuseConfig } from '../observability/langfuse'
import type { EvalCaseResult, EvalRunArtifact } from './types'

/** Langfuse dataset/scores 同步结果。 */
export interface LangfuseDatasetExportResult {
  datasetName: string
  datasetRunName: string
  datasetItemCount: number
  datasetRunItemCount: number
  scoreCount: number
  warnings: string[]
  caseUpdates: Map<string, {
    datasetItemId?: string
    datasetRunItemId?: string
    scoreIds?: string[]
  }>
}

/** 将本地 eval run 同步为 Langfuse dataset run items 与 scores。 */
export async function exportEvalDatasetAndScoresToLangfuse(
  artifact: EvalRunArtifact,
  config: LangfuseConfig,
  traceId: string
): Promise<LangfuseDatasetExportResult> {
  const client = new LangfusePublicApiClient(config)
  const datasetName = `q-code/${artifact.summary.suiteName}`
  const datasetRunName = artifact.summary.runId
  const warnings: string[] = []
  const caseUpdates = new Map<string, {
    datasetItemId?: string
    datasetRunItemId?: string
    scoreIds?: string[]
  }>()
  let datasetItemCount = 0
  let datasetRunItemCount = 0
  let scoreCount = 0

  try {
    await client.post('/api/public/v2/datasets', {
      name: datasetName,
      description: `q-code eval suite ${artifact.summary.suiteName}`
    })
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      warnings.push(`dataset.create: ${formatError(error)}`)
    }
  }

  for (const result of artifact.results) {
    const datasetItemId = createDatasetItemId(datasetName, result.caseId)
    try {
      const item = await client.post<{ id?: string }>('/api/public/dataset-items', {
        id: datasetItemId,
        datasetName,
        input: {
          caseId: result.caseId,
          name: result.name,
          tags: result.tags,
          difficulty: result.difficulty
        },
        expectedOutput: {
          checks: result.checks.map((check) => check.name)
        },
        metadata: {
          source: 'q-code',
          caseId: result.caseId,
          tags: result.tags,
          difficulty: result.difficulty
        },
        sourceTraceId: traceId
      })
      datasetItemCount++
      const createdItemId = item.id ?? datasetItemId
      const runItem = await client.post<{ id?: string }>('/api/public/dataset-run-items', {
        runName: datasetRunName,
        runDescription: `q-code eval ${artifact.summary.suiteName}`,
        metadata: {
          runId: artifact.summary.runId,
          suiteName: artifact.summary.suiteName,
          outputDir: artifact.summary.outputDir,
          startedAt: artifact.summary.startedAt,
          finishedAt: artifact.summary.finishedAt
        },
        datasetItemId: createdItemId,
        traceId,
        createdAt: artifact.summary.startedAt
      })
      datasetRunItemCount++
      const runItemId = runItem.id
      const scoreIds = await createCaseScores(client, result, traceId, runItemId)
      scoreCount += scoreIds.length
      caseUpdates.set(result.runCaseId, {
        datasetItemId: createdItemId,
        ...(runItemId ? { datasetRunItemId: runItemId } : {}),
        ...(scoreIds.length > 0 ? { scoreIds } : {})
      })
    } catch (error) {
      warnings.push(`${result.caseId}: ${formatError(error)}`)
    }
  }

  return {
    datasetName,
    datasetRunName,
    datasetItemCount,
    datasetRunItemCount,
    scoreCount,
    warnings,
    caseUpdates
  }
}

async function createCaseScores(
  client: LangfusePublicApiClient,
  result: EvalCaseResult,
  traceId: string,
  datasetRunItemId: string | undefined
): Promise<string[]> {
  const scoreSpecs: Array<{ name: string; value: number; comment?: string; metadata?: Record<string, unknown> }> = [
    { name: 'q-code.success', value: result.success ? 1 : 0, comment: result.errorMessage },
    { name: 'q-code.score', value: result.score },
    { name: 'q-code.progress_rate', value: result.progressRate },
    { name: 'q-code.tool_execution_validity', value: result.toolMetrics.failedCalls === 0 ? 1 : 0 },
    { name: 'q-code.duration_ms', value: result.durationMs },
    { name: 'q-code.total_tokens', value: result.usage.totalTokens }
  ]
  if (result.estimatedCostUsd !== undefined) {
    scoreSpecs.push({ name: 'q-code.estimated_cost_usd', value: result.estimatedCostUsd })
  }
  if (result.judgeScore !== undefined) {
    scoreSpecs.push({
      name: 'q-code.judge_score',
      value: result.judgeScore,
      comment: result.judgeReason,
      metadata: { judgePassed: result.judgePassed }
    })
  }

  const ids: string[] = []
  for (const score of scoreSpecs) {
    const response = await client.post<{ id?: string }>('/api/public/scores', {
      traceId,
      name: score.name,
      value: score.value,
      dataType: 'NUMERIC',
      source: 'API',
      ...(score.comment ? { comment: truncate(score.comment, 500) } : {}),
      metadata: {
        caseId: result.caseId,
        runCaseId: result.runCaseId,
        repeatIndex: result.repeatIndex,
        errorType: result.errorType,
        ...(score.metadata ?? {})
      }
    })
    if (response.id) ids.push(response.id)
  }
  return ids
}

class LangfusePublicApiClient {
  constructor(private readonly config: LangfuseConfig) {}

  async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.config.publicKey || !this.config.secretKey) {
      throw new Error('Langfuse public/secret key missing')
    }
    const response = await fetch(new URL(path, this.config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString('base64')}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutSeconds * 1000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Langfuse API ${path} HTTP ${response.status}${text ? `: ${truncate(text, 300)}` : ''}`)
    }
    return await response.json() as T
  }
}

function createDatasetItemId(datasetName: string, caseId: string): string {
  const hash = createHash('sha256').update(`${datasetName}:${caseId}`).digest('hex').slice(0, 24)
  return `q-code-${hash}`
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...[truncated ${value.length - max} chars]`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAlreadyExistsError(error: unknown): boolean {
  const message = formatError(error).toLowerCase()
  return (
    message.includes('http 400') ||
    message.includes('http 409')
  ) && (
    message.includes('already') ||
    message.includes('exist') ||
    message.includes('unique') ||
    message.includes('duplicate')
  )
}
