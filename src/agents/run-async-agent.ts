/**
 * 后台 SubAgent / 队友的完整生命周期：JSONL 输出、内存状态表更新、
 * worktree 清理、`<task-notification>` 入队，以及队友 `isActive` 收尾。
 */
import {
  completeAsyncAgent,
  failAsyncAgent,
  getAsyncAgent,
  markAsyncAgentKilled,
  updateAsyncAgentProgress,
  type AsyncAgentEntry
} from './async-agent-store'
import { enqueuePendingNotification, formatTaskNotification } from './notification-store'
import { runChildAgent } from './run-agent'
import { setMemberActive } from './team-helpers'
import { appendTaskOutput, previewToolResult } from './task-output'
import { cleanupWorktreeIfClean, type WorktreeInfo } from './worktree'
import type { AgentDefinition } from './types'
import type { TeammateIdentity, ToolDefinition } from '../tools/registry'
import type { HookRunner } from '../hooks'
import { getAuditLogger } from '../observability/audit'

/** `runAsyncAgentLifecycle` 的输入（由 `Agent` 工具在后台分支构造）。 */
export interface RunAsyncAgentLifecycleParams {
  entry: AsyncAgentEntry
  agentDefinition: AgentDefinition
  prompt: string
  availableTools: ToolDefinition[]
  model: any
  runtimeContext?: string
  agentMdContext?: string
  tokenBudget?: number
  maxOutputTokens?: number
  escalatedMaxOutputTokens?: number
  sessionId?: string
  hooks?: HookRunner
  worktreeInfo?: WorktreeInfo
  /**
   * 若存在，表示本次后台运行为 Agent Teams 命名队友。
   * 会转发给 `runChildAgent`；`finally` 中无论成功/失败/被杀都会将 `isActive` 置 false。
   */
  teammateIdentity?: TeammateIdentity
}

/**
 * 在后台执行子 Agent 循环并同步更新 `async-agent-store`、任务输出文件与通知队列。
 * 本函数不向外抛错：错误路径会写入 failed/killed 状态并 enqueue 通知。
 */
export async function runAsyncAgentLifecycle(params: RunAsyncAgentLifecycleParams): Promise<void> {
  const startTime = Date.now()
  const { entry } = params

  await appendTaskOutput(entry.outputFile, {
    type: 'started',
    agentType: entry.agentType,
    description: entry.description,
    prompt: params.prompt
  })

  try {
    const result = await runChildAgent({
      agentDefinition: params.agentDefinition,
      prompt: params.prompt,
      availableTools: params.availableTools,
      model: params.model,
      runtimeContext: params.runtimeContext,
      agentMdContext: params.agentMdContext,
      tokenBudget: params.tokenBudget,
      maxOutputTokens: params.maxOutputTokens,
      escalatedMaxOutputTokens: params.escalatedMaxOutputTokens,
      sessionId: params.sessionId,
      hooks: params.hooks,
      ...(params.worktreeInfo ? { cwdOverride: params.worktreeInfo.worktreePath } : {}),
      ...(params.teammateIdentity ? { teammateIdentity: params.teammateIdentity } : {}),
      abortSignal: entry.abortController.signal,
      quiet: true,
      onProgress: (event) => {
        switch (event.type) {
          case 'text':
            void appendTaskOutput(entry.outputFile, { type: 'text', text: event.text })
            break
          case 'tool_use':
            void appendTaskOutput(entry.outputFile, {
              type: 'tool_use',
              toolName: event.toolName,
              ...(event.toolCallId ? { toolCallId: event.toolCallId } : {})
            })
            updateAsyncAgentProgress(entry.agentId, { lastToolName: event.toolName })
            break
          case 'tool_progress':
            void appendTaskOutput(entry.outputFile, {
              type: 'tool_progress',
              toolName: event.toolName,
              ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
              text: event.text
            })
            updateAsyncAgentProgress(entry.agentId, { lastToolName: event.toolName })
            break
          case 'tool_result': {
            const nextToolUseCount = entry.toolUseCount + 1
            entry.toolUseCount = nextToolUseCount
            void appendTaskOutput(entry.outputFile, {
              type: 'tool_result',
              toolName: event.toolName,
              ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
              isError: event.isError === true,
              preview: previewToolResult(event.output)
            })
            updateAsyncAgentProgress(entry.agentId, {
              toolUseCount: nextToolUseCount,
              lastToolName: event.toolName
            })
            break
          }
          case 'turn_usage':
            void appendTaskOutput(entry.outputFile, {
              type: 'turn_usage',
              inputTokens: event.cumulativeUsage.inputTokens,
              outputTokens: event.cumulativeUsage.outputTokens,
              totalTokens: event.cumulativeUsage.totalTokens,
              turn: event.turnCount
            })
            updateAsyncAgentProgress(entry.agentId, {
              inputTokens: event.cumulativeUsage.inputTokens,
              outputTokens: event.cumulativeUsage.outputTokens,
              totalTokens: event.cumulativeUsage.totalTokens,
              turnCount: event.turnCount
            })
            break
        }
      }
    })

    const worktreeFinal = await cleanupWorktreeIfClean(params.worktreeInfo)
    const durationMs = Date.now() - startTime
    const wasKilled =
      getAsyncAgent(entry.agentId)?.status === 'killed' || entry.abortController.signal.aborted
    if (wasKilled) {
      await appendTaskOutput(entry.outputFile, {
        type: 'failed',
        error: 'Background agent was killed',
        durationMs
      })
      markAsyncAgentKilled(entry.agentId, durationMs, 'Background agent was killed', worktreeFinal)
      getAuditLogger().emit(
        'subagent.kill',
        {
          agentId: entry.agentId,
          agentType: entry.agentType,
          durationMs,
          reason: 'Background agent was killed'
        },
        {
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          agent: params.teammateIdentity
            ? {
                kind: 'teammate',
                agentType: entry.agentType,
                agentName: params.teammateIdentity.agentName,
                teamName: params.teammateIdentity.teamName
              }
            : { kind: 'subagent', agentId: entry.agentId, agentType: entry.agentType }
        }
      )
      enqueuePendingNotification({
        mode: 'task-notification',
        text: formatTaskNotification({
          agentId: entry.agentId,
          agentType: entry.agentType,
          status: 'killed',
          description: entry.description,
          outputFile: entry.outputFile,
          error: 'Background agent was killed',
          durationMs,
          ...worktreeFinal
        })
      })
      return
    }

    await appendTaskOutput(entry.outputFile, {
      type: 'completed',
      finalText: result.finalText,
      durationMs,
      totalTokens: result.totalTokens,
      toolUseCount: result.totalToolUseCount
    })

    completeAsyncAgent(entry.agentId, result, worktreeFinal)
    getAuditLogger().emit(
      'subagent.complete',
      {
        agentId: entry.agentId,
        agentType: entry.agentType,
        durationMs,
        totalTokens: result.totalTokens,
        toolUseCount: result.totalToolUseCount
      },
      {
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        agent: params.teammateIdentity
          ? {
              kind: 'teammate',
              agentType: entry.agentType,
              agentName: params.teammateIdentity.agentName,
              teamName: params.teammateIdentity.teamName
            }
          : { kind: 'subagent', agentId: entry.agentId, agentType: entry.agentType }
      }
    )
    enqueuePendingNotification({
      mode: 'task-notification',
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status: 'completed',
        description: entry.description,
        outputFile: entry.outputFile,
        finalText: result.finalText,
        durationMs,
        totalTokens: result.totalTokens,
        toolUseCount: result.totalToolUseCount,
        ...worktreeFinal
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const durationMs = Date.now() - startTime
    const worktreeFinal = await cleanupWorktreeIfClean(params.worktreeInfo)
    const wasKilled =
      getAsyncAgent(entry.agentId)?.status === 'killed' || entry.abortController.signal.aborted

    await appendTaskOutput(entry.outputFile, {
      type: 'failed',
      error: message,
      durationMs
    })

    if (wasKilled) {
      markAsyncAgentKilled(entry.agentId, durationMs, message, worktreeFinal)
      getAuditLogger().emit(
        'subagent.kill',
        {
          agentId: entry.agentId,
          agentType: entry.agentType,
          durationMs,
          reason: message
        },
        {
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          agent: { kind: 'subagent', agentId: entry.agentId, agentType: entry.agentType }
        }
      )
    } else {
      failAsyncAgent(entry.agentId, message, durationMs, worktreeFinal)
      getAuditLogger().emit(
        'subagent.fail',
        {
          agentId: entry.agentId,
          agentType: entry.agentType,
          durationMs,
          message
        },
        {
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          agent: { kind: 'subagent', agentId: entry.agentId, agentType: entry.agentType }
        }
      )
    }

    enqueuePendingNotification({
      mode: 'task-notification',
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status: wasKilled ? 'killed' : 'failed',
        description: entry.description,
        outputFile: entry.outputFile,
        error: message,
        durationMs,
        ...worktreeFinal
      })
    })
  } finally {
    // 无论 completed / failed / killed，都必须把队友 isActive 翻回 false。
    // TeamDelete 会等待全部队友 inactive；遗漏会导致 lead roster 上永久 [active] 幽灵队友。
    if (params.teammateIdentity) {
      try {
        await setMemberActive(
          params.teammateIdentity.teamName,
          params.teammateIdentity.agentName,
          false
        )
      } catch {
        // 簿记类操作，不向调用方传播。
      }
    }
  }
}
