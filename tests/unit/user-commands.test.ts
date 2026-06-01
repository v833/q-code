import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  expandUserCommand,
  loadUserCommands,
  tokenizeCommandArgs,
  type UserCommandConfig
} from '../../src/user-commands'

const originalQCodeHome = process.env.Q_CODE_HOME

beforeEach(() => {
  delete process.env.Q_CODE_HOME
})

afterEach(() => {
  if (originalQCodeHome === undefined) delete process.env.Q_CODE_HOME
  else process.env.Q_CODE_HOME = originalQCodeHome
})

describe('User Commands', () => {
  it('loads markdown commands, namespace directories, frontmatter and project override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-user-command-'))
    const home = join(root, 'home')
    const cwd = join(root, 'project')
    process.env.Q_CODE_HOME = home
    await mkdir(join(home, 'commands', 'git'), { recursive: true })
    await mkdir(join(cwd, '.q-code', 'commands'), { recursive: true })
    await writeFile(join(home, 'commands', 'review.md'), [
      '---',
      'description: user review',
      'argument-hint: <file>',
      'model: gpt-4.1-mini',
      'allowed-tools: [read_file, grep]',
      '---',
      'Review $1 with $ARGUMENTS[1]'
    ].join('\n'))
    await writeFile(join(home, 'commands', 'git', 'sync.md'), 'Sync $ARGUMENTS')
    await writeFile(join(cwd, '.q-code', 'commands', 'review.md'), [
      '---',
      'description: project review',
      '---',
      'Project review $ARGUMENTS'
    ].join('\n'))

    const result = await loadUserCommands(cwd)

    expect(result.commands.map((command) => command.name)).toEqual(['git:sync', 'review'])
    expect(result.commands.find((command) => command.name === 'review')).toMatchObject({
      description: 'project review',
      source: 'project',
      prompt: 'Project review $ARGUMENTS'
    })
  })

  it('ignores commands that conflict with built-in slash commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-user-command-'))
    const home = join(root, 'home')
    const cwd = join(root, 'project')
    process.env.Q_CODE_HOME = home
    await mkdir(join(home, 'commands'), { recursive: true })
    await writeFile(join(home, 'commands', 'help.md'), 'Help me')

    const result = await loadUserCommands(cwd, ['/help'])

    expect(result.commands).toEqual([])
    expect(result.warnings.join('\n')).toContain('与内置 Slash 命令冲突')
  })

  it('tokenizes quoted args and replaces placeholders', () => {
    const command = makeCommand('Review $ARGUMENTS | $1 | $2 | $ARGUMENTS[0] | $ARGUMENTS[2]')

    const expanded = expandUserCommand(command, '"hello world" foo')

    expect(tokenizeCommandArgs('"hello world" foo')).toEqual(['hello world', 'foo'])
    expect(expanded.prompt).toBe('Review "hello world" foo | hello world | foo | hello world | ')
  })

  it('appends ARGUMENTS when template has no placeholders', () => {
    const expanded = expandUserCommand(makeCommand('Explain this'), 'src/foo.ts')

    expect(expanded.prompt).toBe('Explain this\n\nARGUMENTS: src/foo.ts')
  })
})

function makeCommand(prompt: string): UserCommandConfig {
  return {
    name: 'review',
    description: 'Review',
    prompt,
    source: 'user',
    filePath: '/tmp/review.md',
    warnings: []
  }
}
