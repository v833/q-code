/**
 * Skill 列表字符预算：控制 system-reminder 中 Skill 摘要长度。
 */
import type { Skill } from './types'

/** 单条 Skill 描述在列表中的最大字符数。 */
export const MAX_LISTING_DESC_CHARS = 250
const MIN_DESC_CHARS_PER_SKILL = 20
const DEFAULT_SKILL_CHAR_BUDGET = 8000

/** 读取 `Q_CODE_SKILL_CHAR_BUDGET` 或返回默认预算。 */
export function getSkillCharBudget(): number {
  const value = process.env.Q_CODE_SKILL_CHAR_BUDGET?.trim()
  if (!value) return DEFAULT_SKILL_CHAR_BUDGET

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SKILL_CHAR_BUDGET
}

/** 在字符预算内格式化 Skill 列表行（多级降级：完整描述 → 均分 → 仅名称）。 */
export function formatSkillsWithinBudget(
  skills: Skill[],
  budget: number = getSkillCharBudget()
): string {
  if (skills.length === 0) return ''

  const tier1 = skills.map((skill) => buildLine(skill, MAX_LISTING_DESC_CHARS))
  if (sumLines(tier1) <= budget) return tier1.join('\n')

  const prefixCost = skills.reduce((sum, skill) => sum + `- ${skill.name}: `.length + 1, 0)
  const descBudget = budget - prefixCost
  if (descBudget >= skills.length * MIN_DESC_CHARS_PER_SKILL) {
    const perDesc = Math.max(MIN_DESC_CHARS_PER_SKILL, Math.floor(descBudget / skills.length))
    const tier2 = skills.map((skill) => buildLine(skill, perDesc))
    if (sumLines(tier2) <= budget) return tier2.join('\n')
  }

  return skills.map((skill) => `- ${skill.name}`).join('\n')
}

/** 生成注入 system prompt 的 `<system-reminder>` Skill 列表块。 */
export function formatSkillsSystemReminder(skills: Skill[]): string {
  const listing = formatSkillsWithinBudget(skills)
  if (!listing) return ''

  return [
    '<system-reminder>',
    'Available skills you can invoke via the `Skill` tool. Each line is `- <name>: <description>`.',
    'Call `Skill(skill="<name>", args="<optional args>")` when the user\'s request matches one of these.',
    '',
    listing,
    '</system-reminder>'
  ].join('\n')
}

function buildLine(skill: Skill, descMax: number): string {
  const cappedMax = Math.min(descMax, MAX_LISTING_DESC_CHARS)
  const fullDescription = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description
  return `- ${skill.name}: ${truncateDescription(fullDescription, cappedMax)}`
}

function truncateDescription(description: string, max: number): string {
  if (description.length <= max) return description
  if (max <= 3) return '...'
  return `${description.slice(0, max - 3).trimEnd()}...`
}

function sumLines(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}
