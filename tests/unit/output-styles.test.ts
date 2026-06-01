import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findOutputStyle,
  formatOutputStylePrompt,
  loadOutputStyles,
  persistOutputStyle
} from '../../src/output-styles'

const originalQCodeHome = process.env.Q_CODE_HOME

beforeEach(() => {
  delete process.env.Q_CODE_HOME
})

afterEach(() => {
  if (originalQCodeHome === undefined) delete process.env.Q_CODE_HOME
  else process.env.Q_CODE_HOME = originalQCodeHome
})

describe('Output Styles', () => {
  it('loads built-in styles and defaults to default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-output-style-'))
    process.env.Q_CODE_HOME = join(root, 'home')

    const result = await loadOutputStyles(join(root, 'project'))

    expect(result.activeName).toBe('default')
    expect(result.styles.map((style) => style.name)).toEqual(
      expect.arrayContaining(['default', 'Explanatory', 'Learning'])
    )
  })

  it('loads frontmatter styles with project overriding user and restores settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-output-style-'))
    const home = join(root, 'home')
    const cwd = join(root, 'project')
    process.env.Q_CODE_HOME = home
    await mkdir(join(home, 'output-styles'), { recursive: true })
    await mkdir(join(cwd, '.q-code', 'output-styles'), { recursive: true })
    await writeFile(join(home, 'output-styles', 'concise.md'), [
      '---',
      'name: Concise',
      'description: user concise',
      '---',
      'User prompt'
    ].join('\n'))
    await writeFile(join(cwd, '.q-code', 'output-styles', 'concise.md'), [
      '---',
      'name: Concise',
      'description: project concise',
      'keepCodingInstructions: false',
      '---',
      'Project prompt'
    ].join('\n'))
    await mkdir(join(cwd, '.q-code'), { recursive: true })
    await writeFile(join(cwd, '.q-code', 'settings.json'), JSON.stringify({ outputStyle: 'Concise' }))

    const result = await loadOutputStyles(cwd)
    const concise = findOutputStyle(result.styles, 'concise')

    expect(result.activeName).toBe('Concise')
    expect(concise).toMatchObject({
      description: 'project concise',
      prompt: 'Project prompt',
      keepCodingInstructions: false,
      source: 'project'
    })
    expect(formatOutputStylePrompt(concise)).toContain('必须保留安全')
  })

  it('persists outputStyle to project settings when project settings already exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-output-style-'))
    const home = join(root, 'home')
    const cwd = join(root, 'project')
    process.env.Q_CODE_HOME = home
    await mkdir(join(cwd, '.q-code'), { recursive: true })
    await writeFile(join(cwd, '.q-code', 'settings.json'), JSON.stringify({ hooks: {} }))

    const target = await persistOutputStyle(cwd, 'Explanatory')
    const saved = JSON.parse(await readFile(target, 'utf-8')) as Record<string, unknown>

    expect(target).toBe(join(cwd, '.q-code', 'settings.json'))
    expect(saved.outputStyle).toBe('Explanatory')
    expect(saved.hooks).toEqual({})
  })

  it('persists project output styles to project settings even when settings is new', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-output-style-'))
    const home = join(root, 'home')
    const cwd = join(root, 'project')
    process.env.Q_CODE_HOME = home

    const target = await persistOutputStyle(cwd, 'team-style', 'project')
    const saved = JSON.parse(await readFile(target, 'utf-8')) as Record<string, unknown>

    expect(target).toBe(join(cwd, '.q-code', 'settings.json'))
    expect(saved.outputStyle).toBe('team-style')
  })
})
