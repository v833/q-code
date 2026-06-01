import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildMemorySystemContext,
  getProjectMemoryDir,
  listMemoryFiles,
  sha256MemoryText,
  shouldIgnoreMemory,
  touchMemoryAccessedAt,
  writeProjectMemory
} from '../../src/context/memory/memdir'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

describe('project memory memdir', () => {
  let home: TempHome | undefined

  afterEach(() => {
    home?.dispose()
    home = undefined
  })

  it('writes createdAt/updatedAt metadata and preserves createdAt on update', async () => {
    home = setupTempHome('memory-meta-')

    const first = await writeProjectMemory({
      cwd: home.cwd,
      name: '测试约定',
      description: '项目测试偏好',
      type: 'feedback',
      content: '使用 pnpm test:unit。',
      fileName: 'testing.md'
    })
    const firstText = await readFile(first.filePath, 'utf-8')

    expect(first.updatedExisting).toBe(false)
    expect(firstText).toContain('createdAt:')
    expect(firstText).toContain('updatedAt:')

    const second = await writeProjectMemory({
      cwd: home.cwd,
      name: '测试约定',
      description: '项目测试偏好',
      type: 'feedback',
      content: '使用 pnpm precommit。',
      fileName: 'testing.md'
    })
    const docs = await listMemoryFiles({ cwd: home.cwd })

    expect(second.updatedExisting).toBe(true)
    expect(second.metadata.createdAt).toBe(first.metadata.createdAt)
    expect(second.metadata.updatedAt).not.toBe('')
    expect(docs[0]?.frontmatter.createdAt).toBe(first.metadata.createdAt)
    expect(docs[0]?.body).toContain('pnpm precommit')
  })

  it('keeps old memory files readable and skips index when user ignores memory', async () => {
    home = setupTempHome('memory-legacy-')
    const memoryDir = await getProjectMemoryDir({ cwd: home.cwd })
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'legacy.md'), [
      '---',
      'name: Legacy',
      'description: old format',
      'type: project',
      '---',
      '',
      'old body'
    ].join('\n'))

    const docs = await listMemoryFiles({ cwd: home.cwd })
    const ignored = await buildMemorySystemContext({ cwd: home.cwd, userQuery: '这次忽略记忆' })

    expect(docs[0]?.frontmatter.updatedAt).toBeUndefined()
    expect(docs[0]?.body).toBe('old body')
    expect(shouldIgnoreMemory('please ignore memory for this')).toBe(true)
    expect(ignored).toContain('本轮用户要求忽略记忆')
    expect(ignored).not.toContain('Legacy')
  })

  it('does not update lastAccessedAt when the memory was changed after injection', async () => {
    home = setupTempHome('memory-touch-')
    const first = await writeProjectMemory({
      cwd: home.cwd,
      name: '并发记忆',
      description: '防止旧 touch 覆盖新内容',
      type: 'project',
      content: 'old content',
      fileName: 'race.md'
    })
    await writeProjectMemory({
      cwd: home.cwd,
      name: '并发记忆',
      description: '防止旧 touch 覆盖新内容',
      type: 'project',
      content: 'new content',
      fileName: 'race.md'
    })

    const touched = await touchMemoryAccessedAt(
      { cwd: home.cwd },
      'race.md',
      first.metadata.updatedAt,
      sha256MemoryText('old content'),
      '2026-06-02T00:00:00.000Z'
    )
    const docs = await listMemoryFiles({ cwd: home.cwd })

    expect(touched).toBe(false)
    expect(docs[0]?.body).toContain('new content')
    expect(docs[0]?.frontmatter.lastAccessedAt).toBeUndefined()
  })
})
