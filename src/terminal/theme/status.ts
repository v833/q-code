/**
 * 状态栏文案本地化与按 {@link TerminalStatus} 映射颜色。
 */
import type { TerminalStatus } from '../events'
import { animeTheme } from './palette'

/** 将英文/内部状态文案转为中文状态栏展示。 */
export function statusMood(status: TerminalStatus, text: string): string {
  if (status === 'running_tool') {
    return text.replace(/^Running\s+/, '魔法道具启动: ')
  }
  if (status === 'thinking') return '脑内演出中'
  if (status === 'compacting') return '整理记忆胶卷'
  if (status === 'recovering') return text || '正在恢复'
  if (status === 'error') return '剧情卡住了'
  if (text && text !== 'Ready') return text
  return '待机中'
}

/** 按状态返回 Ink 颜色名。 */
export function statusColor(status: TerminalStatus): string {
  if (status === 'running_tool') return animeTheme.duck
  if (status === 'thinking') return animeTheme.candy
  if (status === 'compacting') return animeTheme.lavender
  if (status === 'recovering') return animeTheme.duck
  if (status === 'error') return animeTheme.danger
  return animeTheme.mint
}
