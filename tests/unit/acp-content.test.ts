import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { convertAcpPromptContent } from '../../src/acp/content'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('ACP prompt content', () => {
  it('combines text and image blocks without writing image data to disk', () => {
    const result = convertAcpPromptContent({
      prompt: [
        { type: 'text', text: '请检查图片' },
        { type: 'image', data: PNG_BASE64, mimeType: 'image/png' }
      ]
    }, process.cwd())

    expect(result.prompt).toBe('请检查图片')
    expect(result.imageAttachments).toHaveLength(1)
    expect(result.imageAttachments[0]?.source).toBe('acp')
    expect(result.imageAttachments[0]?.path).toMatch(/^acp:\/\//)
  })

  it('turns an in-workspace file resource link into an @file mention', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'q-code-acp-content-'))
    const filePath = join(cwd, 'README.md')
    writeFileSync(filePath, '# ACP', 'utf8')
    try {
      const result = convertAcpPromptContent({
        prompt: [{
          type: 'resource_link',
          name: 'README',
          uri: pathToFileURL(filePath).href
        }]
      }, cwd)
      expect(result.prompt).toBe('@README.md')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects embedded resources and unsupported audio', () => {
    expect(() => convertAcpPromptContent({
      prompt: [{
        type: 'resource',
        resource: { uri: 'data:text/plain,hello', text: 'hello' }
      }]
    }, process.cwd())).toThrow(/embedded resource/)
    expect(() => convertAcpPromptContent({
      prompt: [{ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }]
    }, process.cwd())).toThrow(/audio/)
  })
})
