/**
 * 进程内「当前 lead 正在指挥哪支团队」的注册表。
 *
 * 单进程同时只能 lead 一支团队（与源码约束一致）；`TeamCreate` 在
 * 已有上下文时会拒绝。团队元数据持久化在磁盘（`TeamFile`，见 `team-helpers`），
 * 本模块供 `SendMessage`、`Agent` 工具与 system prompt 构建器免磁盘读取地查询
 * 「我是否在团队中 / 团队名是什么」。
 */

/** 当前进程作为 lead 活跃的团队上下文。 */
export interface TeamContext {
  teamName: string
  leadAgentId: string
  teamFilePath: string
  createdAt: number
}

let current: TeamContext | null = null

type Listener = (ctx: TeamContext | null) => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of listeners) {
    try {
      l(current)
    } catch {
      // 订阅方（如 TUI）异常不得打断状态迁移。
    }
  }
}

/**
 * 设置当前活跃团队。
 * 若已存在不同 `teamName` 的上下文则抛错——`TeamCreate` 会先检查
 * `getActiveTeam()`，此处为纵深防御。
 */
export function setActiveTeam(ctx: TeamContext): void {
  if (current !== null && current.teamName !== ctx.teamName) {
    throw new Error(
      `Already leading team "${current.teamName}". Run TeamDelete before creating a new team.`
    )
  }
  current = ctx
  notify()
}

/** 清除活跃团队上下文（`TeamDelete` 成功后调用）。 */
export function clearActiveTeam(): void {
  if (current === null) return
  current = null
  notify()
}

export function getActiveTeam(): TeamContext | null {
  return current
}

export function isInActiveTeam(): boolean {
  return current !== null
}

/** 订阅活跃团队变化；返回取消订阅函数。 */
export function subscribeActiveTeam(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
