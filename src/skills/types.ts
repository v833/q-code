/**
 * Skill 类型：frontmatter 解析结果与内存中的 Skill 实体。
 */

/**
 * Skill 来源目录类型（用于展示与优先级覆盖）。
 *
 * 同名 Skill 覆盖优先级：
 * project-agents > project-qcode > user-agents > user-qcode
 */
export type SkillSource =
  | 'user-qcode'
  | 'user-agents'
  | 'project-qcode'
  | 'project-agents'

/** SKILL.md YAML frontmatter 解析后的结构化字段。 */
export interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  allowedTools: string[]
  argumentHint?: string
  disableModelInvocation: boolean
  paths?: string[]
  hasForkContext: boolean
  raw: Record<string, unknown>
}

/** 已加载的 Skill 实体。 */
export interface Skill {
  name: string
  description: string
  whenToUse?: string
  body: string
  filePath: string
  baseDir: string
  source: SkillSource
  frontmatter: SkillFrontmatter
}
