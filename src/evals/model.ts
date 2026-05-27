/**
 * Eval 模型工厂：为真实 Agent 与 LLM judge 创建 OpenAI 兼容模型。
 *
 * 这里不复用 `src/index.ts` 的私有函数，避免 eval 子命令误触发 TUI/MCP
 * 主流程；配置仍沿用运行时 `.env` / config.toml 写入的环境变量。
 */
import { createOpenAI } from '@ai-sdk/openai'
import { normalizeBaseURL } from '../utils'

/** OpenAI 兼容模型环境变量配置。 */
export interface EvalModelEnvSpec {
  model?: string
  baseUrlEnv?: string
  apiKeyEnv?: string
  modelEnv?: string
}

/** 创建 AI SDK chat model，并返回最终模型名。 */
export function createEvalChatModel(spec: EvalModelEnvSpec = {}): { model: any; modelName: string } {
  const baseUrlEnv = spec.baseUrlEnv ?? 'OPENAI_BASE_URL'
  const apiKeyEnv = spec.apiKeyEnv ?? 'OPENAI_API_KEY'
  const modelEnv = spec.modelEnv ?? 'OPENAI_MODEL'
  const modelName = spec.model ?? readRequiredEnv(modelEnv)
  const openai = createOpenAI({
    baseURL: normalizeBaseURL(readRequiredEnv(baseUrlEnv)),
    apiKey: readRequiredEnv(apiKeyEnv)
  })

  return { model: openai.chat(modelName), modelName }
}

/** 创建 judge 模型；默认复用 SUMMARY_*，更适合低成本稳定评分。 */
export function createEvalJudgeModel(spec: EvalModelEnvSpec = {}): { model: any; modelName: string } {
  ensureJudgeEnvFallbacks()
  return createEvalChatModel({
    baseUrlEnv: spec.baseUrlEnv ?? 'Q_CODE_EVAL_JUDGE_BASE_URL',
    apiKeyEnv: spec.apiKeyEnv ?? 'Q_CODE_EVAL_JUDGE_API_KEY',
    modelEnv: spec.modelEnv ?? 'Q_CODE_EVAL_JUDGE_MODEL',
    model: spec.model
  })
}

/** judge 专用 env 未配置时，回退到 SUMMARY_*。 */
export function ensureJudgeEnvFallbacks(env: NodeJS.ProcessEnv = process.env): void {
  if (!hasText(env.Q_CODE_EVAL_JUDGE_BASE_URL) && hasText(env.SUMMARY_BASE_URL)) {
    env.Q_CODE_EVAL_JUDGE_BASE_URL = env.SUMMARY_BASE_URL
  }
  if (!hasText(env.Q_CODE_EVAL_JUDGE_API_KEY) && hasText(env.SUMMARY_API_KEY)) {
    env.Q_CODE_EVAL_JUDGE_API_KEY = env.SUMMARY_API_KEY
  }
  if (!hasText(env.Q_CODE_EVAL_JUDGE_MODEL) && hasText(env.SUMMARY_MODEL)) {
    env.Q_CODE_EVAL_JUDGE_MODEL = env.SUMMARY_MODEL
  }
}

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  throw new Error(`Missing required eval model configuration: ${name}`)
}
