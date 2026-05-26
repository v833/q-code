/**
 * Skill 调用：斜杠展开、prompt 正文构建与名称校验。
 */
import type { ModelMessage } from 'ai'
import { findSkill } from './registry'
import type { Skill } from './types'

/** Skill 名称允许的字符集正则。 */
export const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/

/** 斜杠调用 Skill 后注入会话的消息载荷。 */
export interface SkillInvocation {
  skill: Skill
  markerContent: string
  bodyText: string
  messages: ModelMessage[]
}

/** 将 `/skill-name [args]` 展开为 marker + body 两条 user 消息；未命中返回 null。 */
export function expandSkillSlashCommand(input: string, sessionId: string): SkillInvocation | null {
  const match = input.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null

  const [, name, rawArgs] = match
  const skill = findSkill(name)
  if (!skill) return null

  const args = rawArgs?.trim() ?? ''
  const markerContent = buildCommandMarker(skill.name, args)
  const bodyText = buildSkillPromptText(skill, args, sessionId, true)

  return {
    skill,
    markerContent,
    bodyText,
    messages: [
      { role: 'user', content: markerContent },
      { role: 'user', content: bodyText }
    ]
  }
}

/** 构建注入模型的 Skill 工作流正文（含 $ARGUMENTS 替换）。 */
export function buildSkillPromptText(
  skill: Skill,
  args: string,
  sessionId: string,
  includeInvocationMarker = false
): string {
  const dir = posixifyPath(skill.baseDir)
  const prefix = includeInvocationMarker ? `[skill_invocation:${skill.name}]\n` : ''
  return [
    `${prefix}Run skill "${skill.name}" with the following instructions.`,
    `Base directory for this skill: ${dir}`,
    '',
    substituteSkillVariables(skill.body, skill, args, sessionId)
  ].join('\n')
}

function substituteSkillVariables(
  body: string,
  skill: Skill,
  args: string,
  sessionId: string
): string {
  const dir = posixifyPath(skill.baseDir)
  return body
    .replaceAll('${Q_CODE_SKILL_DIR}', dir)
    .replaceAll('${Q_CODE_SESSION_ID}', sessionId)
    .replaceAll('${CLAUDE_SKILL_DIR}', dir)
    .replaceAll('${CLAUDE_SESSION_ID}', sessionId)
    .replaceAll('$ARGUMENTS', args)
}

function buildCommandMarker(name: string, args: string): string {
  const lines = [
    `<command-message>${escapeXml(name)}</command-message>`,
    `<command-name>/${escapeXml(name)}</command-name>`
  ]
  if (args) lines.push(`<command-args>${escapeXml(args)}</command-args>`)
  return lines.join('\n')
}

function posixifyPath(value: string): string {
  return value.split(/[\\/]/).join('/')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
