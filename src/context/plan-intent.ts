/**
 * Plan Mode 意图识别：用保守的本地规则处理自然语言审批、修订与智能进入，
 * 并为可选 LLM judge 兜底提供 JSON 解析与安全归一化。
 */

/** 待确认计划状态下，用户自然语言输入对应的安全动作。 */
export type PendingPlanIntent =
  | { type: 'approve' }
  | { type: 'revise'; feedback: string }
  | { type: 'exit' }
  | { type: 'cancel' }
  | { type: 'show_plan' }
  | { type: 'unknown' }

/** 普通输入进入 Agent turn 前的 Plan Mode 路由建议。 */
export type PlanEntryIntent =
  | { type: 'enter_plan'; reason: string }
  | { type: 'suggest_plan'; reason: string }
  | { type: 'stay_normal' }

/** Plan Mode 语义入口配置模式。 */
export type PlanIntentMode = 'auto' | 'suggest' | 'off'

const DEFAULT_PLAN_INTENT_MODEL_TIMEOUT_MS = 3000
const MIN_APPROVE_CONFIDENCE = 0.9
const MIN_ACTION_CONFIDENCE = 0.7

const APPROVE_EXACT = new Set([
  '可以',
  '可',
  '好',
  '好的',
  '行',
  '没问题',
  '同意',
  '批准',
  '开始',
  '开始吧',
  '执行',
  '执行吧',
  '按这个来',
  '就这样',
  '继续',
  'ok',
  'okay',
  'approve',
  'approved',
  'go',
  'go ahead',
  'do it',
  'yes',
  'y',
  'run it',
  'start'
])

const APPROVE_PATTERNS = [
  '按这个方案',
  '按这个计划',
  '就按这个',
  '照这个',
  '开始执行',
  '可以执行',
  '确认执行',
  'approved plan',
  'run the plan'
]

const EXIT_EXACT = [
  '退出',
  '退出计划',
  '退出 plan',
  '退出plan',
  '退出计划模式',
  '回普通模式',
  '切回普通模式',
  'normal mode',
  'exit plan',
  'leave plan',
  'stop planning'
]

const CANCEL_EXACT = [
  '取消',
  '取消计划',
  '不做了',
  '算了',
  '停止',
  '停',
  'cancel',
  'abort',
  'stop'
]

const SHOW_PLAN_EXACT = [
  '看计划',
  '显示计划',
  '查看计划',
  'plan',
  'show plan',
  'show the plan'
]

const NEGATION_PATTERNS = [
  '不要执行',
  '别执行',
  '先别执行',
  '不要开始',
  '别开始',
  '先别开始',
  '不可以',
  '不批准',
  'not approve',
  'do not',
  "don't",
  'dont',
  'don t',
  'not yet',
  'hold on',
  '不要退出',
  '别退出',
  '不要取消',
  '别取消',
  'do not exit',
  "don't exit",
  'dont exit',
  'don t exit',
  'do not cancel',
  "don't cancel",
  'dont cancel',
  'don t cancel'
]

const REVISE_HINTS = [
  '改',
  '调整',
  '补充',
  '不对',
  '重新',
  '风险',
  '考虑',
  '缺少',
  '再看看',
  '再想',
  '细化',
  '完善',
  '加上',
  '删掉',
  '换成',
  'review',
  'revise',
  'change',
  'adjust',
  'update',
  'add',
  'remove',
  'risk',
  'missing',
  'instead'
]

const ENTER_PLAN_HINTS = [
  '先给方案',
  '先出方案',
  '先写方案',
  '先别改',
  '先不要改',
  '先不改',
  '只分析',
  '不要修改',
  '别修改',
  '不要动代码',
  '别动代码',
  '评估一下',
  '评估风险',
  '怎么做比较好',
  '如何实现比较好',
  '写个计划',
  '制定计划',
  '给个计划',
  '先规划',
  '进入计划',
  'plan mode',
  'planning mode',
  'make a plan',
  'write a plan',
  'do not edit',
  "don't edit",
  'analyze only',
  'analysis only',
  'assess risk',
  'evaluate risk'
]

const SUGGEST_PLAN_HINTS = [
  '完整实现',
  '完整重构',
  '重构整个',
  '重构一下',
  '改一套',
  '迁移',
  '多阶段',
  '跨模块',
  '整个模块',
  '平台',
  '架构',
  '权限',
  '工作流',
  'complex',
  'refactor',
  'migration',
  'architecture',
  'multi-step',
  'workflow'
]

/** 读取 Plan Mode 意图配置，未知值按默认 `auto` 处理。 */
export function readPlanIntentMode(env: NodeJS.ProcessEnv = process.env): PlanIntentMode {
  const normalized = normalize(env.Q_CODE_PLAN_INTENT)
  if (normalized === 'suggest' || normalized === 'off' || normalized === 'auto') return normalized
  return 'auto'
}

/** 读取 Plan Mode LLM 兜底判断超时；0 表示关闭模型兜底。 */
export function readPlanIntentModelTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.Q_CODE_PLAN_INTENT_MODEL_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_PLAN_INTENT_MODEL_TIMEOUT_MS
  const value = Number(raw.replace(/_/g, ''))
  if (!Number.isFinite(value) || value < 0) return DEFAULT_PLAN_INTENT_MODEL_TIMEOUT_MS
  return Math.floor(value)
}

/** 分类待确认计划时用户的自然语言输入。 */
export function classifyPendingPlanIntent(input: string): PendingPlanIntent {
  const normalized = normalizeUserInput(input)
  if (!normalized) return { type: 'unknown' }

  const hasNegation = containsAny(normalized, NEGATION_PATTERNS)
  const hasReviseHint = containsAny(normalized, REVISE_HINTS)
  if (hasNegation || hasReviseHint) return { type: 'revise', feedback: input.trim() }

  if (containsAny(normalized, EXIT_EXACT)) return { type: 'exit' }
  if (containsAny(normalized, CANCEL_EXACT)) return { type: 'cancel' }
  if (SHOW_PLAN_EXACT.includes(normalized)) return { type: 'show_plan' }

  if (APPROVE_EXACT.has(normalized)) return { type: 'approve' }
  if (containsAny(normalized, APPROVE_PATTERNS)) return { type: 'approve' }

  if (normalized.length >= 8) return { type: 'revise', feedback: input.trim() }
  return { type: 'unknown' }
}

/** 分类普通输入是否应进入或建议进入 Plan Mode。 */
export function classifyPlanEntryIntent(input: string): PlanEntryIntent {
  const normalized = normalizeUserInput(input)
  if (!normalized || isSlashLike(normalized)) return { type: 'stay_normal' }

  if (containsAny(normalized, ENTER_PLAN_HINTS)) {
    return { type: 'enter_plan', reason: '检测到明确的只读规划/分析意图' }
  }

  if (containsAny(normalized, SUGGEST_PLAN_HINTS)) {
    return { type: 'suggest_plan', reason: '任务可能涉及多文件或多阶段修改' }
  }

  return { type: 'stay_normal' }
}

/** 从 LLM judge 文本中解析 pending plan 意图，并按置信度与否定词做安全降级。 */
export function parsePendingPlanIntentJudgeResponse(
  raw: string,
  originalInput: string
): PendingPlanIntent {
  const parsed = parseJudgeJson(raw)
  const intent = parseJudgeIntent(parsed.intent)
  if (!intent) return { type: 'unknown' }

  const confidence = clampConfidence(Number(parsed.confidence))
  if (intent === 'approve') {
    if (confidence < MIN_APPROVE_CONFIDENCE || hasNegation(originalInput)) return { type: 'unknown' }
    return { type: 'approve' }
  }
  if (confidence < MIN_ACTION_CONFIDENCE) return { type: 'unknown' }

  if (intent === 'revise') {
    const feedback =
      typeof parsed.feedback === 'string' && parsed.feedback.trim()
        ? parsed.feedback.trim()
        : originalInput.trim()
    return feedback ? { type: 'revise', feedback } : { type: 'unknown' }
  }

  return { type: intent }
}

function normalizeUserInput(input: string): string {
  return normalize(input)
    .replace(/[。！？!?,，；;：:、"'“”‘’()[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalize(input: string | undefined): string {
  return input?.trim().toLowerCase() ?? ''
}

function hasNegation(input: string): boolean {
  return containsAny(normalizeUserInput(input), NEGATION_PATTERNS)
}

function containsAny(input: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => input.includes(pattern))
}

function isSlashLike(input: string): boolean {
  return input.startsWith('/')
}

function parseJudgeJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  const json = trimmed.startsWith('{')
    ? trimmed
    : trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ??
      trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  if (!json || !json.startsWith('{') || !json.endsWith('}')) return {}
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function parseJudgeIntent(value: unknown): PendingPlanIntent['type'] | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (
    normalized === 'approve' ||
    normalized === 'revise' ||
    normalized === 'exit' ||
    normalized === 'cancel' ||
    normalized === 'show_plan' ||
    normalized === 'unknown'
  ) {
    return normalized
  }
  return undefined
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
