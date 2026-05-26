/**
 * 条件 Skill 激活：根据工具触及的文件路径匹配 frontmatter.paths。
 */
import * as path from 'node:path'
import ignore from 'ignore'
import { activateConditionalSkill, listConditionalSkills } from './registry'

/** 对给定仓库相对路径尝试激活匹配的条件 Skill，返回已激活名称列表。 */
export function activateConditionalSkillsForPaths(filePaths: string[], cwd: string): string[] {
  if (filePaths.length === 0) return []

  const candidates = listConditionalSkills()
  if (candidates.length === 0) return []

  const relativePaths = filePaths
    .map((filePath) => toRepoRelative(filePath, cwd))
    .filter((filePath): filePath is string => Boolean(filePath))

  if (relativePaths.length === 0) return []

  const activated: string[] = []
  for (const skill of candidates) {
    const patterns = skill.frontmatter.paths
    if (!patterns || patterns.length === 0) continue

    const matcher = ignore().add(patterns)
    if (relativePaths.some((filePath) => matcher.ignores(filePath))) {
      if (activateConditionalSkill(skill.name)) activated.push(skill.name)
    }
  }

  return activated
}

/** 从文件类工具 input 中提取可能触发条件 Skill 的路径字段。 */
export function extractToolFilePaths(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const record = input as Record<string, unknown>

  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
    return typeof record.path === 'string' ? [record.path] : []
  }

  if (toolName === 'glob') {
    return typeof record.path === 'string' ? [record.path] : []
  }

  return []
}

function toRepoRelative(filePath: string, cwd: string): string | null {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
  const relative = path.relative(cwd, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}
