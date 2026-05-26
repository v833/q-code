/**
 * 子 Agent / 队友的单次 Agent 循环执行器。
 *
 * 负责工具集解析、子 Agent system prompt 组装、邮箱未读消息注入、
 * Hooks/审计事件，以及通过 `onProgress` 向上层（含后台 JSONL）转发进度。
 */
import type { ModelMessage } from 'ai'
import { agentLoop } from '../agent/loop'
import {
  coreRules,
  deferredTools,
  agentMdInstructions,
  PromptBuilder,
  runtimeEnvironment,
  toolGuide,
  type PromptContext
} from '../context/prompt-builder'
import type { TokenUsage } from '../context/token-budget'
import {
  createHookEvent,
  type HookAgentContext,
  type HookRunner
} from '../hooks'
import { createMessageSummaryPayload, getAuditLogger } from '../observability/audit'
import { createToolSearchTool } from '../tools/tool-search-tool'
import { ToolRegistry, type TeammateIdentity, type ToolDefinition } from '../tools/registry'
import { resolveAgentTools } from './resolve-agent-tools'
import { drainUnreadMessages, formatMailboxAttachment } from './teammate-mailbox'
import type { AgentDefinition, AgentRunResult } from './types'

/** 未在定义中指定 `maxTurns` 时的默认最大步数。 */
export const DEFAULT_AGENT_MAX_TURNS = 30

/** `runChildAgent` 的输入参数。 */
export interface RunChildAgentParams {
  agentDefinition: AgentDefinition
  /** 委托给子 Agent 的任务说明（须自包含，子 Agent 看不到主对话）。 */
  prompt: string
  availableTools: ToolDefinition[]
  model: any
  runtimeContext?: string
  agentMdContext?: string
  tokenBudget?: number
  maxOutputTokens?: number
  escalatedMaxOutputTokens?: number
  /** 覆盖进程 cwd（worktree 隔离时使用）。 */
  cwdOverride?: string
  abortSignal?: AbortSignal
  sessionId?: string
  hooks?: HookRunner
  /** 为 true 时不向 TUI 打印子 Agent 流式输出。 */
  quiet?: boolean
  onProgress?: (event: ChildAgentProgressEvent) => void
  /**
   * 若设置，表示本次运行为 Agent Teams 中的命名队友。
   * 身份会转发到每次工具调用；启动时会排空该队友邮箱并 prepend 到首轮 user 消息。
   */
  teammateIdentity?: TeammateIdentity
}

/** 子 Agent 运行过程中的进度事件（供后台任务 JSONL 等消费）。 */
export type ChildAgentProgressEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolName: string; toolCallId?: string }
  | { type: 'tool_progress'; toolName: string; toolCallId?: string; text: string }
  | {
      type: 'tool_result'
      toolName: string
      toolCallId?: string
      isError?: boolean
      output: unknown
    }
  | { type: 'turn_usage'; turnUsage: TokenUsage; cumulativeUsage: TokenUsage; turnCount: number }

/**
 * 在独立上下文中运行一次子 Agent（或队友）循环。
 * 返回最终摘要文本、完整消息历史及用量统计。
 */
export async function runChildAgent(params: RunChildAgentParams): Promise<AgentRunResult> {
  const startTime = Date.now()
  const resolved = resolveAgentTools(params.agentDefinition, params.availableTools)
  const registry = buildChildRegistry(resolved.resolvedTools, resolved.hasWildcard, {
    cwd: params.cwdOverride,
    quiet: params.quiet
  })

  // 队友可能在空闲期间收到 lead/其他队友的 SendMessage；启动时一次性排空并
  // 拼到 opening user 消息前，使第一轮循环即可看到权威协作输入。
  const openingPrompt = await buildOpeningPrompt(params.prompt, params.teammateIdentity)
  const messages: ModelMessage[] = [{ role: 'user', content: openingPrompt }]
  const sessionId = params.sessionId ?? `sub-agent:${params.agentDefinition.agentType}`
  const cwd = params.cwdOverride ?? process.cwd()
  const agentContext: HookAgentContext = params.teammateIdentity
    ? {
        kind: 'teammate',
        agentType: params.agentDefinition.agentType,
        agentName: params.teammateIdentity.agentName,
        teamName: params.teammateIdentity.teamName
      }
    : {
        kind: 'subagent',
        agentType: params.agentDefinition.agentType
      }
  let totalToolUseCount = 0
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let turnCount = 0

  await params.hooks?.run(
    createHookEvent(
      { sessionId, cwd, agent: agentContext },
      {
        event: 'subagent_start',
        subagent: {
          agentType: params.agentDefinition.agentType,
          prompt: openingPrompt
        }
      }
    ),
    { signal: params.abortSignal }
  )
  getAuditLogger().emit(
    'subagent.spawn',
    {
      agentType: params.agentDefinition.agentType,
      ...(params.teammateIdentity ? { teamName: params.teammateIdentity.teamName } : {}),
      prompt: createMessageSummaryPayload(openingPrompt)
    },
    { sessionId, cwd, agent: agentContext }
  )

  const system = buildChildSystemPrompt({
    definition: params.agentDefinition,
    registry,
    runtimeContext: params.runtimeContext,
    agentMdContext: params.agentMdContext,
    teammateIdentity: params.teammateIdentity
  })

  let loopResult: Awaited<ReturnType<typeof agentLoop>>
  try {
    loopResult = await agentLoop(params.model, registry, messages, system, {
      tokenBudget: params.tokenBudget,
      maxOutputTokens: params.maxOutputTokens,
      escalatedMaxOutputTokens: params.escalatedMaxOutputTokens,
      maxSteps: params.agentDefinition.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
      abortSignal: params.abortSignal,
      sessionId,
      hooks: params.hooks,
      agent: agentContext,
      quiet: params.quiet,
      ...(params.teammateIdentity ? { teammateIdentity: params.teammateIdentity } : {}),
      onText: (text) => {
        params.onProgress?.({ type: 'text', text })
      },
      onToolProgress: (event) => {
        if (!event.text) return
        params.onProgress?.({
          type: 'tool_progress',
          toolName: event.name,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          text: event.text
        })
      },
      onToolEvent: (event) => {
        if (event.phase === 'start') {
          totalToolUseCount++
          params.onProgress?.({
            type: 'tool_use',
            toolName: event.name,
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {})
          })
        }
      },
      onToolResult: (event) => {
        params.onProgress?.({
          type: 'tool_result',
          toolName: event.name,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          isError: event.isError === true,
          output: event.output
        })
      },
      onUsage: (_turnUsage, nextTotalUsage) => {
        totalUsage = nextTotalUsage
        turnCount++
        params.onProgress?.({
          type: 'turn_usage',
          turnUsage: _turnUsage,
          cumulativeUsage: nextTotalUsage,
          turnCount
        })
      }
    })
  } catch (error) {
    getAuditLogger().emit(
      'subagent.fail',
      {
        agentType: params.agentDefinition.agentType,
        durationMs: Date.now() - startTime,
        message: formatError(error)
      },
      { sessionId, cwd, agent: agentContext }
    )
    throw error
  }

  await params.hooks?.run(
    createHookEvent(
      { sessionId, cwd, agent: agentContext },
      {
        event: 'subagent_stop',
        subagent: {
          agentType: params.agentDefinition.agentType,
          finalText: extractFinalAssistantText(loopResult.messages),
          reason: 'completed'
        }
      }
    ),
    { signal: params.abortSignal }
  )
  getAuditLogger().emit(
    'subagent.complete',
    {
      agentType: params.agentDefinition.agentType,
      durationMs: Date.now() - startTime,
      totalToolUseCount,
      totalTokens: totalUsage.totalTokens
    },
    { sessionId, cwd, agent: agentContext }
  )

  const warnings =
    resolved.invalidTools.length > 0
      ? [
          `Agent '${params.agentDefinition.agentType}' references unknown or unavailable tools: ${resolved.invalidTools.join(', ')}`
        ]
      : []

  return {
    agentType: params.agentDefinition.agentType,
    finalText: extractFinalAssistantText(loopResult.messages),
    messages: loopResult.messages,
    totalToolUseCount,
    totalDurationMs: Date.now() - startTime,
    totalTokens: totalUsage.totalTokens,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    turnCount: countAssistantTurns(loopResult.newMessages),
    warnings,
    reason: 'completed'
  }
}

/**
 * 队友启动时合并邮箱未读；非队友或排空失败时原样返回 `prompt`。
 * 邮箱属于可观测性能力，失败不应阻塞队友启动。
 */
async function buildOpeningPrompt(
  prompt: string,
  identity: TeammateIdentity | undefined
): Promise<string> {
  if (!identity) return prompt
  try {
    const unread = await drainUnreadMessages(identity.agentName, identity.teamName)
    if (unread.length === 0) return prompt
    return `${formatMailboxAttachment(unread)}\n\n${prompt}`
  } catch {
    return prompt
  }
}

/**
 * 为子 Agent 构建独立 `ToolRegistry`：注册解析后的工具，按需挂载 `tool_search`，
 * 非通配模式下将 `shouldDefer` 工具标记为延迟加载。
 */
function buildChildRegistry(
  tools: ToolDefinition[],
  hasWildcard: boolean,
  options: { cwd?: string; quiet?: boolean } = {}
): ToolRegistry {
  const registry = new ToolRegistry(options)
  const includesToolSearch = tools.some((tool) => tool.name === 'tool_search')
  registry.register(...tools.filter((tool) => tool.name !== 'tool_search'))
  if (includesToolSearch) registry.register(createToolSearchTool(registry))

  if (!hasWildcard) {
    for (const tool of tools) {
      if (tool.shouldDefer) registry.searchTools(tool.name)
    }
  }

  registry.setMode('normal')
  return registry
}

/** 组装子 Agent / 队友的 system prompt（含角色块与共享 prompt 管道）。 */
function buildChildSystemPrompt(params: {
  definition: AgentDefinition
  registry: ToolRegistry
  runtimeContext?: string
  agentMdContext?: string
  teammateIdentity?: TeammateIdentity
}): string {
  const subAgentBlock = params.teammateIdentity
    ? [
        '[Teammate]',
        `你是团队 "${params.teammateIdentity.teamName}" 中的成员 "${params.teammateIdentity.agentName}"，` +
          `agent 类型 ${params.definition.agentType}。`,
        '在独立上下文中运行；主 Agent (lead) 只能看到你的最终摘要。',
        '可以用 SendMessage({ to, message }) 给 lead 或其他 active teammate 发消息；' +
          'to: "team-lead" 即可联系 lead。不允许调用 TeamCreate / TeamDelete，也不能再嵌套派出 teammate。',
        '严格遵守下面的角色说明：',
        '',
        params.definition.getSystemPrompt()
      ].join('\n')
    : [
        '[SubAgent]',
        `当前子 Agent: ${params.definition.agentType}`,
        '你在独立上下文中运行。主 Agent 只能看到你的最终摘要，看不到你的中间消息和工具结果。',
        '严格遵守下面的角色说明：',
        '',
        params.definition.getSystemPrompt()
      ].join('\n')

  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('subAgentInstructions', () => subAgentBlock)
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('runtimeEnvironment', runtimeEnvironment())
    .pipe('agentMdInstructions', agentMdInstructions())

  const ctx: PromptContext = {
    toolCount: params.registry.getActiveTools().length,
    deferredToolSummary: params.registry.getDeferredToolSummary(),
    jitToolSummary: params.registry.getJitToolSummary(),
    sessionMessageCount: 0,
    sessionId: `sub-agent:${params.definition.agentType}`,
    runtimeContext: params.runtimeContext,
    agentMdContext: params.agentMdContext
  }

  return builder.build(ctx)
}

/** 从后往前取第一条含非空文本的 assistant 消息作为 `finalText`。 */
function extractFinalAssistantText(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const text = extractText(message.content).trim()
    if (text) return text
  }
  return '(Sub-agent completed but produced no text output.)'
}

/** 从 string 或 content part 数组中提取纯文本。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function countAssistantTurns(messages: ModelMessage[]): number {
  return messages.filter((message) => message.role === 'assistant').length
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
