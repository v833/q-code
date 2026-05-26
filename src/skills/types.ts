/**
 * Skill 类型：frontmatter 解析结果与内存中的 Skill 实体。
 */

/** Skill 来源：用户级或项目级目录。 */
export type SkillSource = 'user' | 'project'

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
