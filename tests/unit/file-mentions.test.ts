import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createFileMentionIndex,
  expandFileMentions,
  findFileMentionAtCursor,
  formatFileMentionTarget,
  parseFileMentionTarget,
  scoreFileMentionCandidate,
  searchFileMentionIndex,
  type FileMentionIndex
} from '../../src/mentions'

const tempDirs: string[] = []
const GIT_LOCAL_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_WORK_TREE'
]

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('file mention parsing', () => {
  it('parses line, range and regex selectors', () => {
    expect(parseFileMentionTarget('src/index.ts:42')).toEqual({
      path: 'src/index.ts',
      selector: { type: 'line', line: 42 }
    })
    expect(parseFileMentionTarget('src/index.ts:10-20')).toEqual({
      path: 'src/index.ts',
      selector: { type: 'range', startLine: 10, endLine: 20 }
    })
    expect(parseFileMentionTarget('src/index.ts:#runAgentTurn')).toEqual({
      path: 'src/index.ts',
      selector: { type: 'regex', pattern: 'runAgentTurn' }
    })
  })

  it('finds the @file token at the input cursor', () => {
    expect(findFileMentionAtCursor('修一下 @src/runt', 12)).toMatchObject({
      start: 4,
      end: 13,
      query: 'src/runt'
    })
    expect(findFileMentionAtCursor('mail@example.com', 6)).toBeNull()
  })
})

describe('file mention fuzzy index', () => {
  it('sorts stronger fuzzy matches first', () => {
    const index: FileMentionIndex = {
      cwd: 'C:/repo',
      files: ['src/runtime/cli-info.ts', 'docs/routes.md', 'src/terminal/App.tsx'],
      totalFiles: 3,
      truncated: false,
      source: 'git'
    }

    const suggestions = searchFileMentionIndex(index, 'rou')

    expect(suggestions[0]?.path).toBe('docs/routes.md')
    expect(scoreFileMentionCandidate('rti', 'src/runtime/cli-info.ts')).not.toBeNull()
  })

  it('falls back to recursive walk and marks truncated indexes', async () => {
    const cwd = tmp()
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'a.ts'), 'a', 'utf-8')
    writeFileSync(join(cwd, 'src', 'b.ts'), 'b', 'utf-8')
    writeFileSync(join(cwd, 'src', 'c.ts'), 'c', 'utf-8')
    writeFileSync(join(cwd, 'src', 'd.ts'), 'd', 'utf-8')

    const index = await createFileMentionIndex(cwd, 3)

    expect(index.source).toBe('walk')
    expect(index.files).toHaveLength(3)
    expect(index.truncated).toBe(true)
  })

  it('streams git indexes and marks truncated repositories', async () => {
    const cwd = tmp()
    execFileSync('git', ['init'], { cwd, env: createIsolatedGitEnv(), stdio: 'ignore' })
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(cwd, `file-${index}.ts`), String(index), 'utf-8')
    }

    const index = await createFileMentionIndex(cwd, 3)

    expect(index.source).toBe('git')
    expect(index.files).toHaveLength(3)
    expect(index.truncated).toBe(true)
  })

  it('does not include q-code internal storage from git indexes', async () => {
    const cwd = tmp()
    execFileSync('git', ['init'], { cwd, env: createIsolatedGitEnv(), stdio: 'ignore' })
    mkdirSync(join(cwd, '.q-code'), { recursive: true })
    mkdirSync(join(cwd, '.sessions'), { recursive: true })
    writeFileSync(join(cwd, '.q-code', 'file-mention-index.json'), '{}', 'utf-8')
    writeFileSync(join(cwd, '.sessions', 'session.jsonl'), '{}', 'utf-8')
    writeFileSync(join(cwd, 'visible.ts'), 'visible', 'utf-8')

    const index = await createFileMentionIndex(cwd, 10)

    expect(index.source).toBe('git')
    expect(index.files).toEqual(['visible.ts'])
  })
})

describe('file mention expansion', () => {
  it('injects selected file content into the user prompt', () => {
    const cwd = tmp()
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'runtime.ts'), 'export const answer = 42\n', 'utf-8')

    const expansion = expandFileMentions('解释 @src/runtime.ts。', { cwd })

    expect(expansion.included).toHaveLength(1)
    expect(expansion.prompt).toContain('<q-code-file-mentions>')
    expect(expansion.prompt).toContain('export const answer = 42')
    expect(expansion.results[0]).toMatchObject({
      path: 'src/runtime.ts',
      status: 'included'
    })
  })

  it('supports line, range and regex selectors', () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'note.txt'), ['alpha', 'beta', 'gamma'].join('\n'), 'utf-8')

    expect(expandFileMentions('@note.txt:2', { cwd }).included[0]?.content).toBe('beta')
    expect(expandFileMentions('@note.txt:1-2', { cwd }).included[0]?.content).toBe('alpha\nbeta')
    expect(expandFileMentions('@note.txt:#gam+', { cwd }).included[0]?.content).toBe('gamma')
  })

  it('supports quoted paths with spaces', () => {
    const cwd = tmp()
    mkdirSync(join(cwd, 'My Project'), { recursive: true })
    writeFileSync(join(cwd, 'My Project', 'note.txt'), 'quoted', 'utf-8')

    const expansion = expandFileMentions('解释 @"My Project/note.txt"', { cwd })

    expect(formatFileMentionTarget('My Project/note.txt')).toBe('@"My Project/note.txt"')
    expect(findFileMentionAtCursor('解释 @"My Pro', 11)).toMatchObject({ query: 'My Pro' })
    expect(expansion.results[0]).toMatchObject({ status: 'included', path: 'My Project/note.txt' })
    expect(expansion.prompt).toContain('quoted')
  })

  it('blocks absolute paths and path traversal by default', () => {
    const cwd = tmp()
    const outside = join(tmp(), 'secret.txt')
    writeFileSync(outside, 'secret', 'utf-8')

    const absolute = expandFileMentions(`看 @${outside}`, { cwd })
    const traversal = expandFileMentions('看 @../secret.txt', { cwd })

    expect(absolute.results[0]?.status).toBe('blocked')
    expect(absolute.results[0]?.reason).toContain('绝对路径默认被阻止')
    expect(traversal.results[0]?.status).toBe('blocked')
    expect(traversal.results[0]?.reason).toContain('路径越界')
  })

  it('allows absolute paths only when explicitly enabled', () => {
    const cwd = tmp()
    const outside = join(tmp(), 'note.txt')
    writeFileSync(outside, 'outside', 'utf-8')

    const expansion = expandFileMentions(`看 @${outside}`, { cwd, allowAbsolute: true })

    expect(expansion.results[0]?.status).toBe('included')
    expect(expansion.prompt).toContain('outside')
  })

  it('blocks symlinks that resolve outside cwd by default', () => {
    const cwd = tmp()
    const outside = tmp()
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf-8')

    try {
      symlinkSync(outside, join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }

    const expansion = expandFileMentions('@linked/secret.txt', { cwd })

    expect(expansion.results[0]?.status).toBe('blocked')
    expect(expansion.results[0]?.reason).toContain('真实路径')
  })

  it('truncates oversized single files and drops attachments over the total budget', () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'big-a.txt'), 'a'.repeat(120), 'utf-8')
    writeFileSync(join(cwd, 'big-b.txt'), 'b'.repeat(80), 'utf-8')

    const expansion = expandFileMentions('@big-a.txt @big-b.txt', {
      cwd,
      singleFileMaxBytes: 100,
      totalMaxBytes: 150
    })

    expect(expansion.results[0]).toMatchObject({
      status: 'included',
      truncated: true,
      bytes: 100
    })
    expect(expansion.results[1]).toMatchObject({
      status: 'dropped',
      reason: expect.stringContaining('附件总量超过')
    })
    expect(expansion.prompt).not.toContain('b'.repeat(80))
  })

  it('does not read unselected oversized file content into the prompt', () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'huge.txt'), 'x'.repeat(1024 * 1024), 'utf-8')

    const expansion = expandFileMentions('@huge.txt', {
      cwd,
      singleFileMaxBytes: 100,
      totalMaxBytes: 200
    })

    expect(expansion.results[0]).toMatchObject({
      status: 'included',
      truncated: true,
      bytes: 100
    })
    expect(expansion.prompt).not.toContain('x'.repeat(200))
  })

  it('rejects high-risk regex selectors', () => {
    const cwd = tmp()
    writeFileSync(join(cwd, 'note.txt'), 'aaaaaaaaaaaaaaaaaaaaaaaa!', 'utf-8')

    const expansion = expandFileMentions('@note.txt:#(a+)+$', { cwd })

    expect(expansion.results[0]).toMatchObject({
      status: 'invalid',
      reason: expect.stringContaining('高风险回溯')
    })
  })
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'q-code-file-mentions-'))
  tempDirs.push(dir)
  return dir
}

function createIsolatedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of GIT_LOCAL_ENV_KEYS) delete env[key]
  return env
}
