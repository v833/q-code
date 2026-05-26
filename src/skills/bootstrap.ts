/**
 * Skills 启动引导：扫描目录并写入内存注册表。
 */
import { loadAllSkills } from './load-skills-dir'
import { setSkills } from './registry'

/** `bootstrapSkills` 的汇总结果。 */
export interface SkillsBootstrapResult {
  skillCount: number
  conditionalCount: number
  warnings: string[]
}

/** 加载用户/项目 Skill 目录并初始化 registry。 */
export async function bootstrapSkills(cwd: string): Promise<SkillsBootstrapResult> {
  const { skills, warnings } = await loadAllSkills(cwd)
  setSkills(skills)

  const conditionalCount = skills.filter((skill) => {
    return skill.frontmatter.paths && skill.frontmatter.paths.length > 0
  }).length
  const visibleCount = skills.filter((skill) => {
    return !skill.frontmatter.disableModelInvocation && !skill.frontmatter.paths?.length
  }).length

  return {
    skillCount: visibleCount,
    conditionalCount,
    warnings
  }
}
