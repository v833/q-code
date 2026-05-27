/**
 * Eval 到 Langfuse 的可选导出。
 *
 * 当前实现把一次 eval run 建成 `q-code.eval.run` trace，并为每个 case 建
 * evaluator observation。这样不依赖 Langfuse Scores REST 端点的版本细节，
 * 也能在自托管实例中看到评测分数、工具指标和失败归因。
 */
import { SpanStatusCode } from '@opentelemetry/api'
import { startActiveObservation, type LangfuseEvaluator } from '@langfuse/tracing'
import {
  getLangfuseConfig,
  initializeLangfuse,
  shutdownLangfuse
} from '../observability/langfuse'
import { exportEvalDatasetAndScoresToLangfuse } from './langfuse-api'
import type { EvalRunArtifact } from './types'

/** 将 eval run 作为 Langfuse trace/evaluator observations 导出。 */
export async function exportEvalRunToLangfuse(artifact: EvalRunArtifact, options: {
  datasets?: boolean
  strict?: boolean
} = {}): Promise<{
  exported: boolean
  message: string
  datasetName?: string
  datasetRunName?: string
}> {
  const config = getLangfuseConfig()
  if (!config.enabled) return { exported: false, message: 'disabled' }

  const status = initializeLangfuse()
  if (!status.enabled) return { exported: false, message: status.message }

  try {
    let runTraceId: string | undefined
    await startActiveObservation(
      'q-code.eval.run',
      async (run) => {
        runTraceId = run.traceId
        run.updateOtelSpanAttributes({
          metadata: {
            runId: artifact.summary.runId,
            suiteName: artifact.summary.suiteName,
            caseCount: artifact.summary.caseCount,
            resultCount: artifact.summary.resultCount,
            passed: artifact.summary.passed,
            failed: artifact.summary.failed,
            passRate: artifact.summary.passRate,
            averageScore: artifact.summary.averageScore,
            averageProgressRate: artifact.summary.averageProgressRate,
            cwd: artifact.summary.cwd,
            outputDir: artifact.summary.outputDir,
            totalTokens: artifact.summary.totalUsage.totalTokens,
            estimatedCostUsd: artifact.summary.totalEstimatedCostUsd,
            usageCost: artifact.summary.totalUsageCost,
            unknownCostCases: artifact.summary.unknownCostCases,
            durationMs: artifact.summary.durationMs
          },
          level: artifact.summary.failed > 0 ? 'WARNING' : 'DEFAULT',
          statusMessage: artifact.summary.failed > 0 ? 'eval failures' : 'passed'
        })

        for (const result of artifact.results) {
          result.langfuseTraceId = run.traceId
          const evaluator = run.startObservation(
            `eval.case.${result.caseId}`,
            {
              metadata: {
                caseId: result.caseId,
                runCaseId: result.runCaseId,
                repeatIndex: result.repeatIndex,
                tags: result.tags,
                difficulty: result.difficulty,
                success: result.success,
                score: result.score,
                progressRate: result.progressRate,
                errorType: result.errorType,
                durationMs: result.durationMs,
                stepCount: result.stepCount,
                toolMetrics: result.toolMetrics,
                usage: result.usage,
                usageCost: result.usageCost,
                estimatedCostUsd: result.estimatedCostUsd,
                checks: result.checks,
                traceFile: result.traceFile
              },
              level: result.success ? 'DEFAULT' : 'ERROR',
              statusMessage: result.success ? 'passed' : (result.errorType ?? 'failed')
            },
            { asType: 'evaluator' }
          )
          markEvaluatorStatus(evaluator, result.success, result.errorMessage)
          evaluator.end()
        }

        if (artifact.summary.failed > 0) {
          run.otelSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: `${artifact.summary.failed} eval case(s) failed`
          })
        }
        run.end()
      },
      { asType: 'evaluator', endOnExit: false }
    )
    let datasetMessage = ''
    let datasetName: string | undefined
    let datasetRunName: string | undefined
    if (options.datasets && runTraceId) {
      try {
        const dataset = await exportEvalDatasetAndScoresToLangfuse(artifact, config, runTraceId)
        datasetName = dataset.datasetName
        datasetRunName = dataset.datasetRunName
        for (const result of artifact.results) {
          const update = dataset.caseUpdates.get(result.runCaseId)
          if (!update) continue
          if (update.datasetItemId) result.langfuseDatasetItemId = update.datasetItemId
          if (update.datasetRunItemId) result.langfuseDatasetRunItemId = update.datasetRunItemId
          if (update.scoreIds) result.langfuseScoreIds = update.scoreIds
        }
        const warningSuffix = dataset.warnings.length > 0 ? `, warnings=${dataset.warnings.length}` : ''
        datasetMessage =
          `; dataset=${dataset.datasetName}, run=${dataset.datasetRunName}, items=${dataset.datasetRunItemCount}, scores=${dataset.scoreCount}${warningSuffix}`
        if (dataset.warnings.length > 0 && options.strict) {
          throw new Error(dataset.warnings.join('; '))
        }
      } catch (error) {
        if (options.strict) throw error
        datasetMessage = `; dataset export failed: ${formatError(error)}`
      }
    }
    await shutdownLangfuse()
    return {
      exported: true,
      message: `exported to ${config.baseUrl}${datasetMessage}`,
      ...(datasetName ? { datasetName } : {}),
      ...(datasetRunName ? { datasetRunName } : {})
    }
  } catch (error) {
    await shutdownLangfuse().catch(() => undefined)
    return { exported: false, message: `export failed: ${formatError(error)}` }
  }
}

function markEvaluatorStatus(evaluator: LangfuseEvaluator, success: boolean, message: string | undefined): void {
  if (success) return
  evaluator.otelSpan.setStatus({
    code: SpanStatusCode.ERROR,
    message: message ?? 'eval case failed'
  })
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
