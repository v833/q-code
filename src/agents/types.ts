/**
 * SubAgent / Agent Teams 的核心类型定义。
 *
 * `AgentDefinition` 描述可从 `Agent` 工具派出的子 Agent 配置；
 * `AgentRunResult` 是一次子 Agent 循环结束后的汇总结果。
 */
import type { ModelMessage } from 'ai'

/** Agent 定义来源：内置、用户级（`~/.q-code/agents`）或项目级（`<cwd>/.q-code/agents`）。 */
export type AgentSource = 'built-in' | 'user' | 'project'

/**
 * 子 Agent 的文件系统隔离策略。
 * - `none`：与主进程共享 cwd。
 * - `worktree`：在独立 git worktree 中运行（见 `worktree.ts`）。
 */
export type AgentIsolation = 'none' | 'worktree'

/** 子 Agent 的完整定义，由内置、自定义 Markdown 或测试注入。 */
export interface AgentDefinition {
  /** `Agent` 工具的 `subagent_type` 参数值。 */
  agentType: string
  /** 何时应选用该子 Agent 的简短说明（写入 system reminder）。 */
  whenToUse: string
  /** 允许的工具名列表；省略、`[]` 或 `['*']` 表示通配全部可用工具。 */
  tools?: string[]
  /** 在通配解析之外额外禁止的工具名。 */
  disallowedTools?: string[]
  /** 为 true 时仅保留 `isReadOnly === true` 的工具。 */
  readOnlyOnly?: boolean
  /** 覆盖主会话使用的模型 id。 */
  model?: string
  /** Agent 循环最大步数（对应 `agentLoop` 的 `maxSteps`）。 */
  maxTurns?: number
  /** 文件系统隔离方式。 */
  isolation?: AgentIsolation
  source: AgentSource
  /** 自定义 Agent 对应的 `.md` 文件绝对路径（内置 Agent 无此字段）。 */
  filePath?: string
  /** 返回该子 Agent 专属 system prompt 正文。 */
  getSystemPrompt: () => string
}

/** `runChildAgent` 完成一次子 Agent 运行后的结构化结果。 */
export interface AgentRunResult {
  agentType: string
  /** 最后一条非空 assistant 文本；无输出时有占位文案。 */
  finalText: string
  /** 完整对话消息（含工具调用与结果）。 */
  messages: ModelMessage[]
  totalToolUseCount: number
  totalDurationMs: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  /** assistant 消息条数（近似“轮次”）。 */
  turnCount: number
  /** 非致命警告（例如引用了未知工具名）。 */
  warnings: string[]
  reason?: string
}
