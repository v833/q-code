import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as skillLoader from '../../src/skills/load-skills-dir'
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
  vi.stubEnv('HOME', home.root)
  vi.stubEnv('USERPROFILE', home.root)
  vi.stubEnv('HOMEDRIVE', '')
  vi.stubEnv('HOMEPATH', '')
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

  it('prefers higher-priority source when two entries resolve to same realpath', async () => {
    const home = trackHome('q-code-skills-realpath-')

    // 两个不同来源的 skill，模拟它们通过 symlink 指向同一个 realpath。
    writeSkill(
      getUserSkillsDir(),
      'shared',
      '---\nname: shared\ndescription: user q-code shared\n---\nuser body\n'
    )
    writeSkill(
      getProjectAgentsSkillsDir(home.cwd),
      'shared',
      '---\nname: shared\ndescription: project agents shared\n---\nproject body\n'
    )

    const realpathSpy = vi.spyOn(skillLoader, 'resolveRealpath')
    realpathSpy.mockImplementation(async (p) => {
      if (p.endsWith('SKILL.md')) return 'DUMMY_REAL_SKILL_MD'
      return p
    })

    const loaded = await loadAllSkills(home.cwd)

    expect(loaded.warnings).toEqual([])
    expect(loaded.skills.map((skill) => `${skill.name}:${skill.description}`)).toEqual([
      'shared:project agents shared'
    ])
  })
})
