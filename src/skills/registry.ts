/**
 * Skills 内存注册表：动态/条件 Skill 分区与模型可见性过滤。
 */
import type { Skill } from './types'

const dynamicSkills = new Map<string, Skill>()
const conditionalSkills = new Map<string, Skill>()
let initialized = false

/** 用扫描结果替换当前注册表（bootstrap 时调用）。 */
export function setSkills(skills: Skill[]): void {
  dynamicSkills.clear()
  conditionalSkills.clear()

  for (const skill of skills) {
    if (skill.frontmatter.paths && skill.frontmatter.paths.length > 0) {
      conditionalSkills.set(skill.name, skill)
    } else {
      dynamicSkills.set(skill.name, skill)
    }
  }

  initialized = true
}

/** 是否已完成至少一次 setSkills。 */
export function isSkillsInitialized(): boolean {
  return initialized
}

/** 返回允许模型通过 Skill 工具调用的 Skill（排除 disableModelInvocation）。 */
export function getModelVisibleSkills(): Skill[] {
  return [...dynamicSkills.values()].filter((skill) => {
    return !skill.frontmatter.disableModelInvocation
  })
}

/** 返回用户可通过 `/skill-name` 调用的全部 Skill（含条件 Skill）。 */
export function getAllUserInvocableSkills(): Skill[] {
  return [...dynamicSkills.values(), ...conditionalSkills.values()]
}

/** 按名称查找 Skill（动态区优先，其次条件区）。 */
export function findSkill(name: string): Skill | undefined {
  return dynamicSkills.get(name) ?? conditionalSkills.get(name)
}

/** 将条件 Skill 移入动态区；不存在时返回 false。 */
export function activateConditionalSkill(name: string): boolean {
  const skill = conditionalSkills.get(name)
  if (!skill) return false

  conditionalSkills.delete(name)
  dynamicSkills.set(name, skill)
  return true
}

/** 列出尚未激活的条件 Skill。 */
export function listConditionalSkills(): Skill[] {
  return [...conditionalSkills.values()]
}

/** 清空注册表（测试或会话重置）。 */
export function clearSkills(): void {
  dynamicSkills.clear()
  conditionalSkills.clear()
  initialized = false
}
