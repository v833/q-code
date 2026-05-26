/**
 * 启动时 ASCII 小黄鸭横幅及快捷提示文案。
 */

/** {@link formatStartupDuckBanner} 选项。 */
export interface StartupDuckBannerOptions {
  /** 为 true 时在横幅中附加 `/teams` 提示。 */
  teamsEnabled?: boolean
}

/** {@link TranscriptItem.source} 标记，用于 {@link ConversationView} 特殊样式。 */
export const STARTUP_DUCK_SOURCE = 'startup_duck'

/**
 * 生成多行启动横幅（含 continue、斜杠命令提示）。
 */
export function formatStartupDuckBanner(options: StartupDuckBannerOptions = {}): string {
  const teamsHint = options.teamsEnabled ? ' · /teams 团队' : ''
  return [
    '        __',
    '    ___( o)>',
    '   \\ <_. )',
    "    `---'   小黄鸭已就位",
    '  ~ ~ ~ ~ ~',
    '自动保存 · pnpm run continue 可恢复上次对话',
    `/mode plan 规划 · /tasks 任务 · /mcp MCP · /skills Skills · /agents SubAgents${teamsHint}`
  ].join('\n')
}
