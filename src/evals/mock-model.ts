/**
 * Eval 专用 mock 模型：用文件化脚本驱动 AI SDK streamText。
 *
 * 它与测试 helper 的思路一致，但放在生产源码中，供 `q-code eval` 在无真实
 * API key 的情况下稳定跑 Agent 回归。
 */
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { EvalMockTurn } from './types'

/** 构造按 turns 顺序输出的 mock 模型。 */
export function createEvalMockModel(turns: EvalMockTurn[]): {
  model: MockLanguageModelV3
  callCount: () => number
} {
  let cursor = 0

  const model = new MockLanguageModelV3({
    provider: 'q-code-eval',
    modelId: 'q-code-eval-mock',
    doStream: async () => {
      const turn = turns[cursor] ?? { finishReason: 'stop' as const }
      cursor++

      const usage = turn.usage ?? {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
      const finishReason =
        turn.finishReason ?? (turn.tools && turn.tools.length > 0 ? 'tool-calls' : 'stop')

      const parts: any[] = []
      parts.push({ type: 'stream-start', warnings: [] })
      parts.push({ type: 'response-metadata', id: `eval-mock-${cursor}`, modelId: 'q-code-eval-mock' })
      if (turn.text) {
        const textId = `eval-text-${cursor}`
        parts.push({ type: 'text-start', id: textId })
        parts.push({ type: 'text-delta', id: textId, delta: turn.text })
        parts.push({ type: 'text-end', id: textId })
      }
      if (turn.tools) {
        for (const [index, tool] of turn.tools.entries()) {
          const toolCallId = tool.toolCallId ?? `eval-call-${cursor}-${index}`
          parts.push({ type: 'tool-input-start', id: toolCallId, toolName: tool.name })
          parts.push({
            type: 'tool-input-delta',
            id: toolCallId,
            delta: JSON.stringify(tool.input ?? {})
          })
          parts.push({ type: 'tool-input-end', id: toolCallId })
          parts.push({
            type: 'tool-call',
            toolCallId,
            toolName: tool.name,
            input: JSON.stringify(tool.input ?? {})
          })
        }
      }
      parts.push({ type: 'finish', finishReason, usage: toProviderUsage(usage) })

      return {
        stream: simulateReadableStream({ chunks: parts }),
        request: { body: '' },
        response: { headers: {} }
      }
    }
  })

  return {
    model,
    callCount: () => cursor
  }
}

function toProviderUsage(usage: { inputTokens: number; outputTokens: number; totalTokens: number }) {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: usage.inputTokens,
      cacheRead: 0,
      cacheWrite: 0
    },
    outputTokens: {
      total: usage.outputTokens,
      text: usage.outputTokens,
      reasoning: 0
    },
    raw: {
      totalTokens: usage.totalTokens
    }
  }
}
