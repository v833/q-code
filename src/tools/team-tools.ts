/**
 * Agent Teams 工具：TeamCreate、TeamDelete、SendMessage。
 */
import {
  cleanupTeamDirectory,
  formatAgentId,
  getTeamFilePath,
  readTeamFile,
  readTeamFileAsync,
  sanitizeName,
  TEAM_LEAD_NAME,
  writeTeamFileAsync,
  type TeamFile
} from '../agents/team-helpers'
import { clearActiveTeam, getActiveTeam, setActiveTeam } from '../agents/team-context'
import { writeToMailbox } from '../agents/teammate-mailbox'
import { removeAgentWorktree } from '../agents/worktree'
import { isAgentTeamsEnabled } from '../utils/agent-teams-enabled'
import type { ToolDefinition, ToolExecutionContext } from './registry'
import { createMessageSummaryPayload, getAuditLogger } from '../observability/audit'

/**
 * 单条 SendMessage 正文的硬性大小上限，单位字节。
 *
 * 收件人的首轮会通过 formatMailboxAttachment() 把所有未读消息原样
 * 拉进 user prompt。若没有上限，lead 就可能有意或无意地一次性塞爆
 * 队友的上下文窗口。8 KB 对自然语言协作和短片段已经很宽松，但又不至于
 * 被当成代码大段传输通道。
 */
export const MAX_MESSAGE_BYTES = 8 * 1024

// ─── TeamCreate ─────────────────────────────────────────────────────

interface TeamCreateInput {
  team_name?: unknown
  description?: unknown
}

/** 创建 `TeamCreate` 工具。 */
export function createTeamCreateTool(): ToolDefinition {
  return {
    name: 'TeamCreate',
    description:
      '开启一个 Agent Teams 会话。当前 q-code 进程成为团队 lead。' +
      '调用之后可用 `Agent({ name, team_name, run_in_background: true, ... })` 派出命名队友，' +
      '用 `SendMessage` 与他们直接对话。每个进程同时只能有一个团队，需要换一个先调 `TeamDelete`。' +
      '只在用户任务自然拆成长期并行的角色（如 backend + frontend + reviewer）时使用；' +
      '单步小任务请直接用 `Agent(...)`。',
    parameters: {
      type: 'object',
      properties: {
        team_name: {
          type: 'string',
          description:
            '简短可读的团队名（如 "refactor-auth"）。会作为目录段落写入 ~/.q-code/teams/，' +
            '自动 sanitize 为小写字母数字+短横线。'
        },
        description: {
          type: 'string',
          description: '可选的 1-2 句团队目标描述，存入 team.json 供 system prompt 提示模型。'
        }
      },
      required: ['team_name'],
      additionalProperties: false
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    contextCost: 'medium',
    resultShape: 'state',
    jitHint: '只在任务自然需要长期并行角色时创建',
    isEnabled: () => isAgentTeamsEnabled(),
    execute: async (rawInput: TeamCreateInput) => {
      const teamName = typeof rawInput.team_name === 'string' ? rawInput.team_name.trim() : ''
      const description =
        typeof rawInput.description === 'string' ? rawInput.description.trim() : undefined
      if (!teamName) return "Error: 'team_name' is required and must be a non-empty string."

      const active = getActiveTeam()
      if (active) {
        return (
          `Error: this session is already leading team "${active.teamName}". ` +
          `Call TeamDelete first to disband it before creating a new team.`
        )
      }

      const sanitized = sanitizeName(teamName)
      if (!sanitized) {
        return "Error: 'team_name' sanitizes to an empty string. Use letters / digits / hyphens."
      }

      const existing = readTeamFile(teamName)
      if (existing) {
        return (
          `Error: team "${teamName}" already exists on disk (${getTeamFilePath(teamName)}). ` +
          `Pick a different name, or run TeamDelete to remove the previous one first.`
        )
      }

      const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
      const createdAt = Date.now()
      const teamFile: TeamFile = {
        name: teamName,
        ...(description ? { description } : {}),
        createdAt,
        leadAgentId,
        members: [
          {
            agentId: leadAgentId,
            name: TEAM_LEAD_NAME,
            agentType: 'team-lead',
            joinedAt: createdAt,
            isActive: true
          }
        ]
      }

      const teamFilePath = getTeamFilePath(teamName)
      await writeTeamFileAsync(teamName, teamFile)
      setActiveTeam({
        teamName,
        leadAgentId,
        teamFilePath,
        createdAt
      })
      getAuditLogger().emit('team.create', {
        teamName,
        leadAgentId,
        ...(description ? { description: createMessageSummaryPayload(description) } : {})
      })

      return [
        `Team "${teamName}" created. You are the lead (${leadAgentId}).`,
        description ? `description: ${description}` : '',
        `team_file: ${teamFilePath}`,
        '',
        'Next steps:',
        '  1. Spawn a named teammate:',
        `       Agent({ subagent_type: "<agent-type>", name: "<short-name>", team_name: "${teamName}", run_in_background: true, prompt: "...", description: "..." })`,
        '  2. Message a running teammate:',
        '       SendMessage({ to: "<short-name>", summary: "...", message: "..." })',
        "  3. When the team's work is done:",
        '       TeamDelete()',
        '',
        'Reminders:',
        '  - Only ONE team can be active at a time.',
        '  - Teammates cannot themselves call TeamCreate / TeamDelete or spawn sub-teams.'
      ]
        .filter(Boolean)
        .join('\n')
    }
  }
}

// ─── TeamDelete ─────────────────────────────────────────────────────

/** 创建 `TeamDelete` 工具。 */
export function createTeamDeleteTool(): ToolDefinition {
  return {
    name: 'TeamDelete',
    description:
      '解散当前活跃的 Agent Teams 会话：' +
      '删除磁盘上的 team.json 和所有 inboxes，回收每个队友的 worktree（干净的自动删，脏的保留）。' +
      '只要有任何 teammate 的 isActive=true 就拒绝执行——先等通知或用 SendMessage 让他们收尾。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    contextCost: 'medium',
    resultShape: 'state',
    jitHint: '团队收尾时调用',
    isEnabled: () => isAgentTeamsEnabled(),
    execute: async () => {
      const active = getActiveTeam()
      if (!active) return 'Error: no team is currently active. Nothing to delete.'

      const file = await readTeamFileAsync(active.teamName)
      if (!file) {
        clearActiveTeam()
        return (
          `Team "${active.teamName}" was already missing on disk. ` +
          'Cleared the in-process team context.'
        )
      }

      const activeTeammates = file.members.filter((m) => m.name !== TEAM_LEAD_NAME && m.isActive)
      if (activeTeammates.length > 0) {
        const names = activeTeammates.map((m) => m.name).join(', ')
        return (
          `Error: cannot delete team "${active.teamName}" — ${activeTeammates.length} teammate(s) still active: ${names}.\n` +
          'Wait for the <task-notification> they will emit when done, or SendMessage them to wrap up. ' +
          'Once every teammate flips to isActive=false, retry TeamDelete.'
        )
      }

      const preservedWorktrees: string[] = []
      const worktreeWarnings: string[] = []
      for (const member of file.members) {
        if (!member.worktreePath || !member.worktreeBranch || !member.gitRoot) continue
        try {
          const result = await removeAgentWorktree({
            worktreePath: member.worktreePath,
            worktreeBranch: member.worktreeBranch,
            gitRoot: member.gitRoot
          })
          if (!result.ok) {
            preservedWorktrees.push(`  - ${member.name}: ${member.worktreePath} (${result.error})`)
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          worktreeWarnings.push(
            `  - ${member.name}: failed to remove ${member.worktreePath} (${msg})`
          )
        }
      }

      await cleanupTeamDirectory(active.teamName)
      clearActiveTeam()
      getAuditLogger().emit('team.delete', {
        teamName: active.teamName,
        preservedWorktrees: preservedWorktrees.length,
        worktreeWarnings: worktreeWarnings.length
      })

      return [
        `Team "${active.teamName}" disbanded. Removed team file and inboxes.`,
        preservedWorktrees.length > 0
          ? `Preserved worktrees (likely have uncommitted changes — review manually):\n${preservedWorktrees.join('\n')}`
          : '',
        worktreeWarnings.length > 0
          ? `Warnings during worktree cleanup:\n${worktreeWarnings.join('\n')}`
          : '',
        'The session is back to single-agent mode. Call TeamCreate again to start a new team.'
      ]
        .filter(Boolean)
        .join('\n')
    }
  }
}

// ─── SendMessage ────────────────────────────────────────────────────

interface SendMessageInput {
  to?: unknown
  message?: unknown
  summary?: unknown
}

/** 创建 `SendMessage` 工具。 */
export function createSendMessageTool(): ToolDefinition {
  return {
    name: 'SendMessage',
    description:
      '给团队中另一名 teammate 的收件箱发送一条纯文本消息；收件人会在下一轮开头以 <teammate-message> 上下文块看到它。' +
      '`to: "*"` 可广播给所有 active teammate；自发自收会被拒绝。' +
      '只能在已有活跃团队时调用（先调 TeamCreate）。',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            '收件人 teammate 的 `name`（即 `Agent({ name, ... })` 传过的那个），' +
            'lead 写 "team-lead"，广播写 "*"。'
        },
        message: {
          type: 'string',
          description:
            '纯文本正文。请把它当成给人类协作者的指示来写，会被对方当作用户侧的指令读取。'
        },
        summary: {
          type: 'string',
          description: '可选 5-10 词预览，长消息（>200 字）建议带上。'
        }
      },
      required: ['to', 'message'],
      additionalProperties: false
    },
    isReadOnly: false,
    isConcurrencySafe: true,
    contextCost: 'low',
    resultShape: 'state',
    jitHint: '传递短协调消息，避免粘贴大内容',
    isEnabled: () => isAgentTeamsEnabled(),
    execute: async (rawInput: SendMessageInput, context: ToolExecutionContext) => {
      const to = typeof rawInput.to === 'string' ? rawInput.to.trim() : ''
      const message = typeof rawInput.message === 'string' ? rawInput.message : ''
      const summary = typeof rawInput.summary === 'string' ? rawInput.summary.trim() : undefined
      if (!to) return "Error: 'to' is required (teammate name or '*')."
      if (!message || !message.trim()) {
        return "Error: 'message' is required and must be non-empty."
      }
      const messageBytes = Buffer.byteLength(message, 'utf-8')
      if (messageBytes > MAX_MESSAGE_BYTES) {
        return (
          `Error: message body is ${messageBytes} bytes, exceeding the ${MAX_MESSAGE_BYTES}-byte ` +
          'cap on a single SendMessage. Split the content across multiple messages, or have the ' +
          'recipient pull large artifacts from a file you both can read.'
        )
      }

      const active = getActiveTeam()
      if (!active) {
        return (
          'Error: no team is active. Call TeamCreate first, then spawn teammates with ' +
          'Agent({ name, team_name, ... }).'
        )
      }

      const teamFile = await readTeamFileAsync(active.teamName)
      if (!teamFile) {
        return (
          `Error: team "${active.teamName}" is registered in-process but the team file is ` +
          'missing on disk. Run TeamDelete to clear the in-process state and recreate the team.'
        )
      }

      const senderName = context.teammateIdentity?.agentName ?? TEAM_LEAD_NAME
      const timestamp = new Date().toISOString()
      const summaryField = summary ? { summary } : {}

      if (to === '*') {
        const recipients = teamFile.members.filter((m) => m.isActive && m.name !== senderName)
        if (recipients.length === 0) {
          return 'No active teammates to broadcast to (you are the only active member).'
        }
        for (const r of recipients) {
          await writeToMailbox(
            r.name,
            { from: senderName, text: message, timestamp, ...summaryField },
            active.teamName
          )
        }
        const messageSummary = createMessageSummaryPayload(message)
        getAuditLogger().emit(
          'team.message',
          {
            teamName: active.teamName,
            from: senderName,
            to: '*',
            recipients: recipients.map((r) => r.name),
            chars: message.length,
            sha256: messageSummary.sha256
          },
          {
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            cwd: context.cwd,
            agent: context.agent
          }
        )
        return `Broadcast delivered to ${recipients.length} teammate(s): ${recipients.map((r) => r.name).join(', ')}.`
      }

      const recipient = teamFile.members.find((m) => m.name === to)
      if (!recipient) {
        const known = teamFile.members.map((m) => m.name).join(', ')
        return `Error: no teammate named "${to}" in team "${active.teamName}". Known members: ${known}.`
      }
      if (to === senderName) {
        return `Error: cannot SendMessage to yourself ("${to}").`
      }

      await writeToMailbox(
        recipient.name,
        { from: senderName, text: message, timestamp, ...summaryField },
        active.teamName
      )
      const messageSummary = createMessageSummaryPayload(message)
      getAuditLogger().emit(
        'team.message',
        {
          teamName: active.teamName,
          from: senderName,
          to,
          chars: message.length,
          sha256: messageSummary.sha256
        },
        {
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          cwd: context.cwd,
          agent: context.agent
        }
      )

      const offlineHint = recipient.isActive
        ? ''
        : ` (note: "${to}" is currently isActive=false — the message will sit in their inbox until they're respawned.)`
      return `Message delivered to "${to}" in team "${active.teamName}".${offlineHint}`
    }
  }
}
