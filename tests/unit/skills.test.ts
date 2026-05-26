import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'
import {
  getProjectAgentsSkillsDir,
  getProjectSkillsDir,
  getUserAgentsSkillsDir,
  getUserSkillsDir,
  loadAllSkills
} from '../../src/skills/load-skills-dir'

const homes: TempHome[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) home.dispose()
})

function trackHome(label?: string): TempHome {
  const home = setupTempHome(label)
  homes.push(home)
  return home
}

function writeSkill(baseDir: string, dirName: string, content: string): string {
  const skillDir = join(baseDir, dirName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')
  return skillDir
}

describe('skill loader', () => {
  it('loads skills from user .q-code/skills and .agents/skills', async () => {
    const home = trackHome('q-code-skills-')
    vi.stubEnv('HOME', home.root)

    writeSkill(
      getUserSkillsDir(),
      'q-code-only',
      '---\nname: q-code-only\ndescription: user q-code skills\n---\nq-code body\n'
    )
    writeSkill(
      getUserAgentsSkillsDir(),
      'agents-only',
      '---\nname: agents-only\ndescription: user agents skills\n---\nagents body\n'
    )

    const loaded = await loadAllSkills(home.cwd)

    expect(loaded.warnings).toEqual([])
    expect(loaded.skills.map((skill) => `${skill.name}:${skill.description}`).sort()).toEqual([
      'agents-only:user agents skills',
      'q-code-only:user q-code skills'
    ])
    expect(loaded.skills.find((skill) => skill.name === 'agents-only')?.baseDir).toBe(
      realpathSync(join(home.root, '.agents', 'skills', 'agents-only'))
    )
  })

  it('loads skills from user and project dirs with project and .agents overriding by name', async () => {
    const home = trackHome('q-code-skills-')
    vi.stubEnv('HOME', home.root)

    writeSkill(
      getUserSkillsDir(),
      'shared',
      '---\nname: shared\ndescription: user q-code shared\n---\nuser q-code body\n'
    )
    writeSkill(
      getUserAgentsSkillsDir(),
      'shared-agents',
      '---\nname: shared\ndescription: user agents shared\n---\nuser agents body\n'
    )
    writeSkill(
      getProjectSkillsDir(home.cwd),
      'shared-q-code',
      '---\nname: shared\ndescription: project q-code shared\n---\nproject q-code body\n'
    )
    writeSkill(
      getProjectAgentsSkillsDir(home.cwd),
      'shared-agents',
      '---\nname: shared\ndescription: project agents shared\n---\nproject agents body\n'
    )
    writeSkill(
      getProjectAgentsSkillsDir(home.cwd),
      'project-only',
      '---\nname: project-only\ndescription: project only\n---\nproject only body\n'
    )

    const loaded = await loadAllSkills(home.cwd)

    expect(loaded.warnings).toEqual([])
    expect(loaded.skills.map((skill) => `${skill.name}:${skill.description}`).sort()).toEqual([
      'project-only:project only',
      'shared:project agents shared'
    ])
    expect(loaded.skills.find((skill) => skill.name === 'project-only')?.baseDir).toBe(
      realpathSync(join(getProjectAgentsSkillsDir(home.cwd), 'project-only'))
    )
  })
})
