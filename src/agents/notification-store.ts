/**
 * 进程内待投递通知队列：后台 SubAgent 完成后生成的 `<task-notification>`
 * 块，由主 Agent 循环在下一轮 user 消息前 `drain` 注入。
 */

/** 队列中的一条待处理通知。 */
export interface PendingNotification {
  mode: 'task-notification'
  /** 已格式化的 XML 块正文。 */
  text: string
  enqueuedAt: number
}

/** `formatTaskNotification` 的结构化输入。 */
export interface TaskNotificationParts {
  agentId: string
  agentType: string
  status: 'completed' | 'failed' | 'killed'
  description?: string
  outputFile: string
  finalText?: string
  error?: string
  durationMs?: number
  totalTokens?: number
  toolUseCount?: number
  worktreePath?: string
  worktreeBranch?: string
}

const queue: PendingNotification[] = []

/** 入队一条任务完成通知（自动打上 `enqueuedAt`）。 */
export function enqueuePendingNotification(
  notification: Omit<PendingNotification, 'enqueuedAt'>
): void {
  queue.push({ ...notification, enqueuedAt: Date.now() })
}

/** 取出并清空当前队列（FIFO 顺序保持）。 */
export function drainPendingNotifications(): PendingNotification[] {
  return queue.splice(0, queue.length)
}

/** 只读查看队列，不移除。 */
export function peekPendingNotifications(): readonly PendingNotification[] {
  return queue
}

export function pendingNotificationCount(): number {
  return queue.length
}

/** 清空队列（测试用）。 */
export function clearPendingNotifications(): void {
  queue.length = 0
}

/**
 * 将后台任务结果格式化为 lead 可解析的 `<task-notification>` XML 块。
 */
export function formatTaskNotification(parts: TaskNotificationParts): string {
  const lines = ['<task-notification>']
  lines.push(`  <task_id>${parts.agentId}</task_id>`)
  lines.push(`  <agent_type>${parts.agentType}</agent_type>`)
  lines.push(`  <status>${parts.status}</status>`)
  if (parts.description) lines.push(`  <description>${parts.description}</description>`)
  lines.push(`  <output_file>${parts.outputFile}</output_file>`)

  if (parts.finalText) {
    lines.push('  <result>')
    lines.push(parts.finalText)
    lines.push('  </result>')
  }

  if (parts.error) lines.push(`  <error>${parts.error}</error>`)

  const usage = [
    parts.totalTokens !== undefined ? `tokens=${parts.totalTokens}` : null,
    parts.toolUseCount !== undefined ? `tools=${parts.toolUseCount}` : null,
    parts.durationMs !== undefined ? `duration_ms=${parts.durationMs}` : null
  ].filter((item): item is string => item !== null)
  if (usage.length > 0) lines.push(`  <usage>${usage.join(' ')}</usage>`)

  if (parts.worktreePath) {
    lines.push(`  <worktree_path>${parts.worktreePath}</worktree_path>`)
    if (parts.worktreeBranch) {
      lines.push(`  <worktree_branch>${parts.worktreeBranch}</worktree_branch>`)
    }
  }

  lines.push('</task-notification>')
  return lines.join('\n')
}
