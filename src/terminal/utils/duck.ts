/**
 * 启动时 ASCII 鸭子横幅及快捷提示文案。
 */

import {
  DEFAULT_DUCK_PERSONA_ID,
  getDuckPersona,
  type DuckPersonaId,
} from '../../context/duck-persona'

/** {@link formatStartupDuckBanner} 选项。 */
export interface StartupDuckBannerOptions {
  /** 为 true 时在横幅中附加 `/teams` 提示。 */
  teamsEnabled?: boolean
  /** 当前鸭子人格，决定横幅文案。 */
  duckPersona?: DuckPersonaId
}

/** {@link TranscriptItem.source} 标记，用于 {@link ConversationView} 特殊样式。 */
export const STARTUP_DUCK_SOURCE = 'startup_duck'

/**
 * 生成多行启动横幅（含 continue、斜杠命令提示）。
 */
export function formatStartupDuckBanner(options: StartupDuckBannerOptions = {}): string {
  const teamsHint = options.teamsEnabled ? ' · /teams 团队' : ''
  const persona = getDuckPersona(options.duckPersona ?? DEFAULT_DUCK_PERSONA_ID)
  return [
    '        __',
    '    ___( o)>',
    '   \\ <_. )',
    `    \`---'   ${persona.bannerLine}`,
    '  ~ ~ ~ ~ ~',
    '自动保存 · pnpm run continue 可恢复上次对话',
    `/mode plan 规划 · /tasks 任务 · /ya 换鸭 · /mcp MCP · /skills Skills · /agents SubAgents${teamsHint}`,
  ].join('\n')
}
