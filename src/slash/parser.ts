/**
 * 斜杠命令解析：识别 `/name [args]` 形态。
 */
import type { SlashCommandInput } from './types'

/** 解析用户输入；非斜杠或格式非法时返回 null。 */
export function parseSlashCommand(input: string): SlashCommandInput | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null

  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null

  return {
    raw: trimmed,
    name: match[1].toLowerCase(),
    args: match[2]?.trim() ?? ''
  }
}
