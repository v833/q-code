/**
 * Agent 子进程工具：同步/后台子 Agent、Agent Teams 队友校验与 worktree 隔离。
 */
import { randomUUID } from 'node:crypto'
import { failAsyncAgent, registerAsyncAgent } from '../agents/async-agent-store'
import { findAgent, getAllAgents } from '../agents/registry'
import {
  runAsyncAgentLifecycle,
  type RunAsyncAgentLifecycleParams
} from '../agents/run-async-agent'
import { runChildAgent, type RunChildAgentParams } from '../agents/run-agent'
import { ensureTaskOutputFile } from '../agents/task-output'
import { getActiveTeam } from '../agents/team-context'
import {
  addTeamMember,
  formatAgentId,
  removeTeamMember,
  sanitizeName,
  TEAM_LEAD_NAME,
  TeamFileMissingError,
  type TeamMember
} from '../agents/team-helpers'
import type { AgentIsolation, AgentRunResult } from '../agents/types'
import { cleanupWorktreeIfClean, createAgentWorktree, type WorktreeInfo } from '../agents/worktree'
import { isAgentTeamsEnabled } from '../utils/agent-teams-enabled'
import type { HookRunner } from '../hooks'
import type { TeammateIdentity, ToolDefinition, ToolExecutionContext } from './registry'
import { createMessageSummaryPayload, getAuditLogger } from '../observability/audit'

/** Agent 工具依赖的模型、工具集与会话运行时注入接口。 */
export interface AgentToolController {
  createModel: (modelName?: string) => any
  getDefaultModelName: () => string
  getAvailableTools: () => ToolDefinition[]
  getRuntimeContext?: () => string | undefined
  getAgentMdContext?: () => string | undefined
  getMaxOutputTokens?: () => number
  getEscalatedMaxOutputTokens?: () => number
  getSessionId?: () => string
  getCwd?: () => string
  getHooks?: () => HookRunner | undefined
}

/** 同步子 Agent 执行函数类型（可注入测试替身）。 */
export type ChildAgentRunner = (params: RunChildAgentParams) => Promise<AgentRunResult>
/** 后台 Agent 生命周期函数类型（可注入测试替身）。 */
export type AsyncAgentLifecycleRunner = (params: RunAsyncAgentLifecycleParams) => Promise<void>

interface AgentInput {
  prompt?: unknown
  description?: unknown
  subagent_type?: unknown
  model?: unknown
  run_in_background?: unknown
  isolation?: unknown
  name?: unknown
  team_name?: unknown
}

interface NormalizedAgentInput {
  prompt: string
  description: string
  subagentType?: string
  model?: string
  runInBackground?: boolean
  isolation?: AgentIsolation
  name?: string
  teamName?: string
}

/**
 * 创建 `Agent` 工具：支持 SubAgent、后台运行与 Agent Teams 命名队友。
 */
export function createAgentTool(
  controller: AgentToolController,
  runner: ChildAgentRunner = runChildAgent,
  asyncRunner: AsyncAgentLifecycleRunner = runAsyncAgentLifecycle
): ToolDefinition {
  return {
    name: 'Agent',
    description:
      '将一个聚焦子任务委托给专门的 sub-agent。子 Agent 在独立上下文中运行，拥有经过过滤的工具集；可同步返回结果，也可 run_in_background=true 后台运行并在完成后通过 task-notification 回传。' +
      '如果当前已有活跃 Agent Teams（已经调过 TeamCreate），可额外传 name + team_name 把这个 Agent 升级为团队的命名 teammate，便于 SendMessage 寻址。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '自包含任务说明。子 Agent 看不到主对话历史，因此必须包含完成任务所需的上下文、目标和输出要求。'
        },
        description: {
          type: 'string',
          description: '3-8 个字的任务名，用于日志和结果摘要。'
        },
        subagent_type: {
          type: 'string',
          description:
            '要使用的子 Agent 类型，必须来自 system-reminder 的可用列表。缺省为 general-purpose。'
        },
        model: {
          type: 'string',
          description:
            '可选模型覆盖。优先级：本次调用 model > agent 定义 model > 父 Agent 默认模型。'
        },
        run_in_background: {
          type: 'boolean',
          description:
            '为 true 时后台运行并立即返回 async_launched；完成、失败或被终止后，会在下一轮用户输入前注入 task-notification。命名 teammate 必须 true。'
        },
        isolation: {
          type: 'string',
          enum: ['none', 'worktree'],
          description:
            '文件系统隔离级别。worktree 会在 git worktree 中运行子 Agent，避免直接污染主工作区；缺省使用 Agent 定义里的 isolation，再缺省为 none。'
        },
        name: {
          type: 'string',
          description:
            '【Agent Teams】队友的简短可寻址名字（如 "backend"），与 team_name 成对出现。设置后这个 Agent 会被注册到当前团队的 team.json，可被 SendMessage 通过该 name 寻址。命名 teammate 必须 run_in_background=true，且不能由其他 teammate 嵌套创建。'
        },
        team_name: {
          type: 'string',
          description: '【Agent Teams】目标团队名，必须等于当前活跃团队的 name。与 name 成对出现。'
        }
      },
      required: ['prompt', 'description'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    contextCost: 'medium',
    resultShape: 'agent-report',
    jitHint: '把宽探索交给独立上下文，主上下文只收摘要',
    isEnabled: () => getAllAgents().length > 0,
    maxResultChars: 20000,
    execute: async (rawInput: AgentInput, context: ToolExecutionContext) => {
      const input = normalizeInput(rawInput)
      if (!input.prompt) return "Error: 'prompt' is required and must be a non-empty string."
      if (!input.description) {
        return "Error: 'description' is required and must be a non-empty string."
      }

      const teamValidation = validateTeammateInput(input, context)
      if (teamValidation.error) return teamValidation.error

      const agentType = input.subagentType || 'general-purpose'
      const definition = findAgent(agentType)
      if (!definition) {
        const available = getAllAgents()
          .map((agent) => agent.agentType)
          .join(', ')
        return `Error: sub-agent "${agentType}" not found. Available agents: ${available || '(none)'}`
      }

      const modelName = input.model || definition.model || controller.getDefaultModelName()
      const cwd = controller.getCwd?.() ?? context.cwd
      const sessionId = controller.getSessionId?.() ?? 'default'
      const availableTools = controller.getAvailableTools()
      const effectiveIsolation = input.isolation ?? definition.isolation ?? 'none'
      const agentId = createAgentId(agentType, teamValidation.identity?.agentName)
      const isolationSetup = await setupWorktreeIfRequested(effectiveIsolation, cwd, agentId)

      if (input.runInBackground === true) {
        const outputFile = await ensureTaskOutputFile({ cwd, sessionId, agentId })
        const entry = registerAsyncAgent({
          agentId,
          agentType,
          description: input.description,
          prompt: input.prompt,
          outputFile,
          isolated: Boolean(isolationSetup.worktreeInfo),
          ...(isolationSetup.worktreeInfo
            ? {
                worktreePath: isolationSetup.worktreeInfo.worktreePath,
                worktreeBranch: isolationSetup.worktreeInfo.worktreeBranch
              }
            : {})
        })

        // Register the teammate in team.json BEFORE launching the async
        // lifecycle. If the launch races a SendMessage from the lead's
        // next turn, the recipient must already be on the roster — and
        // the lead's next system-prompt render must list it as active.
        if (teamValidation.identity) {
          try {
            await registerTeammate({
              identity: teamValidation.identity,
              agentId,
              agentType,
              model: modelName,
              outputFile,
              worktreeInfo: isolationSetup.worktreeInfo
            })
          } catch (error) {
            // team.json is gone (user manually deleted, or a different
            // process disbanded the team between TeamCreate and now).
            // Roll the async-store entry back so /agents listing is honest.
            failAsyncAgent(agentId, formatError(error), 0)
            const message =
              error instanceof TeamFileMissingError
                ? `Error: cannot register teammate "${teamValidation.identity.agentName}" — ${error.message}. Run TeamDelete to clear the in-process state, then TeamCreate again.`
                : `Error: failed to register teammate: ${formatError(error)}`
            return message
          }
        }

        // Build the asyncRunner params first; if `controller.createModel`
        // throws synchronously we MUST roll back the bookkeeping (entry
        // in async-store, member in team.json) so we don't leak a ghost
        // teammate that's permanently isActive=true.
        let runnerParams: RunAsyncAgentLifecycleParams
        try {
          runnerParams = {
            entry,
            agentDefinition: definition,
            prompt: input.prompt,
            availableTools,
            model: controller.createModel(modelName),
            modelName,
            runtimeContext: controller.getRuntimeContext?.(),
            agentMdContext: controller.getAgentMdContext?.(),
            maxOutputTokens: controller.getMaxOutputTokens?.(),
            escalatedMaxOutputTokens: controller.getEscalatedMaxOutputTokens?.(),
            sessionId,
            hooks: controller.getHooks?.() ?? context.hooks,
            ...(isolationSetup.worktreeInfo ? { worktreeInfo: isolationSetup.worktreeInfo } : {}),
            ...(teamValidation.identity ? { teammateIdentity: teamValidation.identity } : {})
          }
        } catch (error) {
          await rollbackTeammateLaunch(agentId, teamValidation.identity, error)
          return `Error: failed to construct background agent: ${formatError(error)}`
        }

        void asyncRunner(runnerParams).catch(() => {
          /* runAsyncAgentLifecycle owns user-visible failure reporting. */
        })
        getAuditLogger().emit(
          'subagent.spawn',
          {
            agentId,
            agentType,
            background: true,
            description: input.description,
            prompt: createMessageSummaryPayload(input.prompt),
            ...(teamValidation.identity
              ? {
                  teamName: teamValidation.identity.teamName,
                  agentName: teamValidation.identity.agentName
                }
              : {})
          },
          {
            sessionId,
            cwd,
            agent: teamValidation.identity
              ? {
                  kind: 'teammate',
                  agentName: teamValidation.identity.agentName,
                  teamName: teamValidation.identity.teamName,
                  agentType
                }
              : { kind: 'subagent', agentId, agentType }
          }
        )

        return formatAsyncLaunchResult({
          agentType,
          description: input.description,
          modelName,
          agentId,
          outputFile,
          worktreeInfo: isolationSetup.worktreeInfo,
          isolationWarning: isolationSetup.warning,
          teammateIdentity: teamValidation.identity
        })
      }

      try {
        const result = await runner({
          agentDefinition: definition,
          prompt: input.prompt,
          availableTools,
          model: controller.createModel(modelName),
          modelName,
          runtimeContext: controller.getRuntimeContext?.(),
          agentMdContext: controller.getAgentMdContext?.(),
          maxOutputTokens: controller.getMaxOutputTokens?.(),
          escalatedMaxOutputTokens: controller.getEscalatedMaxOutputTokens?.(),
          sessionId,
          hooks: controller.getHooks?.() ?? context.hooks,
          ...(isolationSetup.worktreeInfo
            ? { cwdOverride: isolationSetup.worktreeInfo.worktreePath }
            : {})
        })
        const worktreeFinal = await cleanupWorktreeIfClean(isolationSetup.worktreeInfo)

        return formatAgentToolResult({
          agentType,
          description: input.description,
          modelName,
          result,
          worktreeFinal,
          isolationWarning: isolationSetup.warning
        })
      } catch (error) {
        const worktreeFinal = await cleanupWorktreeIfClean(isolationSetup.worktreeInfo)
        return formatAgentToolFailure({
          agentType,
          description: input.description,
          modelName,
          error: error instanceof Error ? error.message : String(error),
          worktreeFinal,
          isolationWarning: isolationSetup.warning
        })
      }
    }
  }
}

function normalizeInput(input: AgentInput): NormalizedAgentInput {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const subagentType =
    typeof input.subagent_type === 'string' ? input.subagent_type.trim() : undefined
  const model = typeof input.model === 'string' ? input.model.trim() : undefined
  const runInBackground =
    typeof input.run_in_background === 'boolean' ? input.run_in_background : undefined
  const isolation =
    input.isolation === 'none' || input.isolation === 'worktree' ? input.isolation : undefined
  const name = typeof input.name === 'string' ? input.name.trim() : undefined
  const teamName = typeof input.team_name === 'string' ? input.team_name.trim() : undefined

  return {
    prompt,
    description,
    ...(subagentType ? { subagentType } : {}),
    ...(model ? { model } : {}),
    ...(runInBackground !== undefined ? { runInBackground } : {}),
    ...(isolation ? { isolation } : {}),
    ...(name ? { name } : {}),
    ...(teamName ? { teamName } : {})
  }
}

interface TeammateValidationResult {
  error?: string
  identity?: TeammateIdentity
}

/**
 * Run every Agent Teams validation rule (per doc §五) over the
 * normalized input. Returns either an error string ready to hand back
 * to the model, or the resolved teammate identity when this call is a
 * valid named-teammate spawn. Returns `{}` when `name`/`team_name` are
 * absent — that path is a plain SubAgent and skips team logic.
 */
function validateTeammateInput(
  input: NormalizedAgentInput,
  context: ToolExecutionContext
): TeammateValidationResult {
  const { name, teamName } = input

  // Either both or neither.
  if ((name && !teamName) || (!name && teamName)) {
    return { error: "Error: 'name' and 'team_name' must be used together." }
  }
  if (!name || !teamName) return {}

  if (!isAgentTeamsEnabled()) {
    return {
      error:
        "Error: Agent Teams feature is not enabled. Start q-code with --agent-teams or Q_CODE_TEAMS=1 to use 'name' / 'team_name'."
    }
  }

  if (sanitizeName(name) === TEAM_LEAD_NAME) {
    return { error: `Error: "${TEAM_LEAD_NAME}" is reserved for the team lead.` }
  }

  const active = getActiveTeam()
  if (!active) {
    return {
      error:
        'Error: no team is active. Call TeamCreate first, then spawn teammates with this Agent call.'
    }
  }
  if (sanitizeName(teamName) !== sanitizeName(active.teamName)) {
    return {
      error: `Error: team_name "${teamName}" does not match the active team "${active.teamName}".`
    }
  }

  // Teammates cannot themselves spawn sub-teammates. The lead is the
  // only caller without a teammateIdentity in its tool context.
  if (context.teammateIdentity) {
    return {
      error:
        'Error: nested teammate spawn rejected. Only the team lead may add teammates with name/team_name; ' +
        'a teammate that needs help should SendMessage the lead or another teammate instead.'
    }
  }

  // Source-aligned hard requirement: named teammates run async so the
  // lead's loop can keep coordinating in parallel.
  if (input.runInBackground !== true) {
    return {
      error:
        'Error: named teammates must run in background (run_in_background=true). ' +
        'A synchronous teammate would block the lead from coordinating the rest of the team.'
    }
  }

  return {
    identity: {
      agentName: sanitizeName(name),
      teamName: active.teamName
    }
  }
}

/**
 * Append the new teammate to team.json. Called BEFORE the async loop
 * starts so the lead's next system-prompt render and any SendMessage
 * from the next turn both see the new member.
 */
async function registerTeammate(args: {
  identity: TeammateIdentity
  agentId: string
  agentType: string
  model: string
  outputFile: string
  worktreeInfo?: WorktreeInfo
}): Promise<void> {
  const member: TeamMember = {
    agentId: args.agentId,
    name: args.identity.agentName,
    agentType: args.agentType,
    model: args.model,
    joinedAt: Date.now(),
    isActive: true,
    outputFile: args.outputFile,
    ...(args.worktreeInfo
      ? {
          worktreePath: args.worktreeInfo.worktreePath,
          worktreeBranch: args.worktreeInfo.worktreeBranch,
          gitRoot: args.worktreeInfo.gitRoot
        }
      : {})
  }
  await addTeamMember(args.identity.teamName, member)
}

async function setupWorktreeIfRequested(
  isolation: AgentIsolation,
  cwd: string,
  agentId: string
): Promise<{ worktreeInfo?: WorktreeInfo; warning?: string }> {
  if (isolation !== 'worktree') return {}

  try {
    return {
      worktreeInfo: await createAgentWorktree(agentId, cwd)
    }
  } catch (error) {
    return {
      warning: `Worktree isolation requested but setup failed (${formatError(error)}). Falling back to no isolation.`
    }
  }
}

function createAgentId(agentType: string, teammateName?: string): string {
  const safeType = agentType.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'agent'
  if (teammateName) {
    const safeName = teammateName.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 24) || 'teammate'
    return `${safeName}-${safeType}-${randomUUID().slice(0, 6)}`
  }
  return `${safeType}-${randomUUID().slice(0, 8)}`
}

function formatAsyncLaunchResult(args: {
  agentType: string
  description: string
  modelName: string
  agentId: string
  outputFile: string
  worktreeInfo?: WorktreeInfo
  isolationWarning?: string
  teammateIdentity?: TeammateIdentity
}): string {
  const role = args.teammateIdentity
    ? `Teammate '${args.teammateIdentity.agentName}' (type ${args.agentType}) launched in team "${args.teammateIdentity.teamName}".`
    : `Async sub-agent '${args.agentType}' launched successfully.`
  const lines = [
    role,
    `task: ${args.description}`,
    `model: ${args.modelName}`,
    `agent_id: ${args.agentId}`,
    `output_file: ${args.outputFile}`,
    args.worktreeInfo
      ? `worktree: ${args.worktreeInfo.worktreePath} (branch: ${args.worktreeInfo.worktreeBranch})`
      : '',
    args.isolationWarning ? `warning: ${args.isolationWarning}` : '',
    args.teammateIdentity
      ? `提示：用 \`SendMessage({ to: "${args.teammateIdentity.agentName}", ... })\` 给这个队友发消息；它完成后会自动通过 <task-notification> 回传，并把 isActive 翻成 false。`
      : '后台任务完成后会在下一轮用户输入前通过 <task-notification> 回传；除非用户要求，不要主动轮询输出文件。'
  ].filter(Boolean)

  return [
    lines.join('\n'),
    '',
    '<async_launched>',
    `  <agent_id>${args.agentId}</agent_id>`,
    `  <agent_type>${args.agentType}</agent_type>`,
    `  <output_file>${args.outputFile}</output_file>`,
    args.teammateIdentity
      ? `  <teammate_name>${args.teammateIdentity.agentName}</teammate_name>`
      : '',
    args.teammateIdentity ? `  <team_name>${args.teammateIdentity.teamName}</team_name>` : '',
    args.worktreeInfo ? `  <worktree_path>${args.worktreeInfo.worktreePath}</worktree_path>` : '',
    args.worktreeInfo
      ? `  <worktree_branch>${args.worktreeInfo.worktreeBranch}</worktree_branch>`
      : '',
    '</async_launched>'
  ]
    .filter(Boolean)
    .join('\n')
}

function formatAgentToolResult(args: {
  agentType: string
  description: string
  modelName: string
  result: AgentRunResult
  worktreeFinal?: { worktreePath?: string; worktreeBranch?: string }
  isolationWarning?: string
}): string {
  const { agentType, description, modelName, result } = args
  const warnings = [...result.warnings, ...(args.isolationWarning ? [args.isolationWarning] : [])]
  const lines = [
    `Sub-agent '${agentType}' completed.`,
    `task: ${description}`,
    `model: ${modelName}`,
    `turns: ${result.turnCount} | tools used: ${result.totalToolUseCount} | duration: ${result.totalDurationMs}ms`,
    `tokens: ${result.totalTokens} (input ${result.inputTokens}, output ${result.outputTokens})`,
    args.worktreeFinal?.worktreePath
      ? `worktree: ${args.worktreeFinal.worktreePath} (branch: ${args.worktreeFinal.worktreeBranch}) — changes preserved.`
      : '',
    warnings.length > 0
      ? `warnings:\n${warnings.map((warning) => `  - ${warning}`).join('\n')}`
      : ''
  ].filter(Boolean)

  return [lines.join('\n'), '', '<sub_agent_result>', result.finalText, '</sub_agent_result>'].join(
    '\n'
  )
}

function formatAgentToolFailure(args: {
  agentType: string
  description: string
  modelName: string
  error: string
  worktreeFinal?: { worktreePath?: string; worktreeBranch?: string }
  isolationWarning?: string
}): string {
  const lines = [
    `Sub-agent '${args.agentType}' failed.`,
    `task: ${args.description}`,
    `model: ${args.modelName}`,
    `error: ${args.error}`,
    args.worktreeFinal?.worktreePath
      ? `worktree: ${args.worktreeFinal.worktreePath} (branch: ${args.worktreeFinal.worktreeBranch}) — changes preserved.`
      : '',
    args.isolationWarning ? `warning: ${args.isolationWarning}` : ''
  ].filter(Boolean)

  return lines.join('\n')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Undo the bookkeeping done in the named-teammate launch path when the
 * subsequent step (model construction) fails. Without this, a thrown
 * `controller.createModel` would leave the teammate marked
 * `isActive=true` in team.json forever (the `runAsyncAgentLifecycle`
 * `finally` that flips the flag never runs because the lifecycle was
 * never started).
 *
 * Best-effort throughout — rollback failures are logged-via-error
 * propagation only when the original launch error has not already been
 * surfaced to the user.
 */
async function rollbackTeammateLaunch(
  agentId: string,
  identity: TeammateIdentity | undefined,
  cause: unknown
): Promise<void> {
  failAsyncAgent(agentId, formatError(cause), 0)
  if (!identity) return
  await removeTeamMember(identity.teamName, identity.agentName).catch(() => undefined)
}
