import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  extractFallbackDescription,
  normalizeFrontmatter,
  splitFrontmatter
} from './parse-frontmatter'
import type { Skill, SkillSource } from './types'

const SKILL_FILE = 'SKILL.md'

export function getQCodeHome(): string {
  return process.env.Q_CODE_HOME?.trim() || path.join(os.homedir(), '.q-code')
}

export function getUserAgentsSkillsDir(): string {
  return path.join(os.homedir(), '.agents', 'skills')
}

export function getProjectAgentsSkillsDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.agents', 'skills')
}

export function getUserSkillsDir(): string {
  return path.join(getQCodeHome(), 'skills')
}

export function getProjectSkillsDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.q-code', 'skills')
}

interface LoadedFromDir {
  skills: Skill[]
  warnings: string[]
}

export interface LoadAllSkillsResult {
  skills: Skill[]
  warnings: string[]
}

async function loadFromOneDir(dir: string, source: SkillSource): Promise<LoadedFromDir> {
  let entries: string[]
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') return { skills: [], warnings: [] }
    return { skills: [], warnings: [`[skills] Failed to read ${dir}: ${formatError(error)}`] }
  }

  const skills: Skill[] = []
  const warnings: string[] = []

  for (const dirName of entries) {
    const skillDir = path.join(dir, dirName)
    const filePath = path.join(skillDir, SKILL_FILE)

    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err?.code !== 'ENOENT') {
        warnings.push(`[skills] Skipping ${skillDir}: ${formatError(error)}`)
      }
      continue
    }

    const split = splitFrontmatter(raw)
    if (split.parseError) {
      warnings.push(`[skills] Skipping ${dirName}: invalid frontmatter (${split.parseError})`)
      continue
    }

    const frontmatter = normalizeFrontmatter(split.raw, split.body)
    const realFile = await fs.realpath(filePath).catch(() => filePath)
    const realDir = await fs.realpath(skillDir).catch(() => skillDir)
    const name = frontmatter.name ?? dirName
    const description = frontmatter.description ?? extractFallbackDescription(split.body) ?? name

    skills.push({
      name,
      description,
      whenToUse: frontmatter.whenToUse,
      body: split.body,
      filePath: realFile,
      baseDir: realDir,
      source,
      frontmatter
    })
  }

  return { skills, warnings }
}

export async function loadAllSkills(cwd: string): Promise<LoadAllSkillsResult> {
  const [userQCodeResult, userAgentsResult, projectQCodeResult, projectAgentsResult] =
    await Promise.all([
      loadFromOneDir(getUserSkillsDir(), 'user'),
      loadFromOneDir(getUserAgentsSkillsDir(), 'user'),
      loadFromOneDir(getProjectSkillsDir(cwd), 'project'),
      loadFromOneDir(getProjectAgentsSkillsDir(cwd), 'project')
    ])

  const seenRealPaths = new Set<string>()
  const byName = new Map<string, Skill>()

  for (const skill of [
    ...userQCodeResult.skills,
    ...userAgentsResult.skills,
    ...projectQCodeResult.skills,
    ...projectAgentsResult.skills
  ]) {
    if (seenRealPaths.has(skill.filePath)) continue
    seenRealPaths.add(skill.filePath)
    byName.set(skill.name, skill)
  }

  return {
    skills: [...byName.values()],
    warnings: [
      ...userQCodeResult.warnings,
      ...userAgentsResult.warnings,
      ...projectQCodeResult.warnings,
      ...projectAgentsResult.warnings
    ]
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
