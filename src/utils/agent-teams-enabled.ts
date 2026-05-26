/**
 * Agent Teams 功能开关（默认关闭）。
 *
 * 任一条件开启：`--agent-teams` 或 `Q_CODE_TEAMS` 为真值（`1` / `true` / `yes` / `on`）。
 * 关闭时团队相关工具经 `isEnabled()` 从注册表过滤，模型不可见。
 */

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false
  return TRUTHY_VALUES.has(value.trim().toLowerCase())
}

/**
 * 当前进程是否启用 Agent Teams。
 *
 * @returns CLI 含 `--agent-teams` 或 `Q_CODE_TEAMS` 为真值时为 `true`
 */
export function isAgentTeamsEnabled(): boolean {
  if (process.argv.includes('--agent-teams')) return true
  if (isEnvTruthy(process.env.Q_CODE_TEAMS)) return true
  return false
}
