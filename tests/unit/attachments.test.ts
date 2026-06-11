import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createUserAttachmentPayload,
  createUserMessageWithImages,
  detectImageMediaType,
  detectPastedImagePath,
  expandImageMentions,
  IMAGE_ATTACHMENT_MAX_COUNT,
  IMAGE_ATTACHMENT_SINGLE_MAX_BYTES,
  mergeImageAttachments,
  prepareImageAttachment,
  prepareImageAttachmentAsync,
  redactImageMessageForTranscript,
  type ImageAttachment
} from '../../src/attachments'

describe('image attachments', () => {
  const previousAllowAbs = process.env.Q_CODE_MENTION_ALLOW_ABS

  afterEach(() => {
    if (previousAllowAbs === undefined) {
      delete process.env.Q_CODE_MENTION_ALLOW_ABS
    } else {
      process.env.Q_CODE_MENTION_ALLOW_ABS = previousAllowAbs
    }
  })

  it('detects image media types from magic numbers', () => {
    expect(detectImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg')
    expect(detectImageMediaType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(detectImageMediaType(Buffer.from('RIFFxxxxWEBP'))).toBe('image/webp')
    expect(detectImageMediaType(Buffer.from('<svg></svg>'), 'icon.svg')).toBe('image/svg+xml')
  })

  it('detects absolute pasted image paths', () => {
    const cwd = makeTempDir()
    const imagePath = join(cwd, 'shot.png')
    writePng(imagePath)

    expect(detectPastedImagePath(`"${imagePath}"`)).toBe(imagePath)
    expect(detectPastedImagePath(`${imagePath}\nextra`)).toBeUndefined()
    expect(detectPastedImagePath(join(cwd, 'note.txt'))).toBeUndefined()
  })

  it('prepares local image attachments within cwd', () => {
    const cwd = makeTempDir()
    const imagePath = join(cwd, 'debug.png')
    writePng(imagePath)

    const attachment = prepareImageAttachment('debug.png', { cwd, source: 'mention' })

    expect(attachment.displayName).toBe('debug.png')
    expect(attachment.mediaType).toBe('image/png')
    expect(attachment.data).not.toContain('data:image')
    expect(attachment.sha256).toHaveLength(64)
  })

  it('prepares local image attachments asynchronously', async () => {
    const cwd = makeTempDir()
    writePng(join(cwd, 'async.png'))

    const attachment = await prepareImageAttachmentAsync('async.png', { cwd, source: 'path' })

    expect(attachment.displayName).toBe('async.png')
    expect(attachment.mediaType).toBe('image/png')
    expect(attachment.data).not.toContain('data:image')
  })

  it('blocks absolute image paths unless explicitly allowed', () => {
    const cwd = makeTempDir()
    const outside = join(makeTempDir(), 'outside.png')
    writePng(outside)

    expect(() => prepareImageAttachment(outside, { cwd, source: 'path' })).toThrow('绝对路径默认被阻止')

    process.env.Q_CODE_MENTION_ALLOW_ABS = 'true'
    expect(prepareImageAttachment(outside, { cwd, source: 'path' }).path).toBe(outside)
  })

  it('expands @image mentions and removes successful tokens from prompt', () => {
    const cwd = makeTempDir()
    writePng(join(cwd, 'debug.png'))

    const expansion = expandImageMentions('请看 @image:./debug.png 的报错', { cwd })

    expect(expansion.prompt).toBe('请看 的报错')
    expect(expansion.attachments).toHaveLength(1)
    expect(expansion.attachments[0]?.source).toBe('mention')
    expect(expansion.warnings).toEqual([])
  })

  it('supports quoted @image paths with spaces', () => {
    const cwd = makeTempDir()
    writePng(join(cwd, 'My Shot.png'))

    const expansion = expandImageMentions('请看 @image:"./My Shot.png"', { cwd })

    expect(expansion.prompt).toBe('请看')
    expect(expansion.attachments[0]?.displayName).toBe('My Shot.png')
  })

  it('keeps failed @image tokens and reports warnings', () => {
    const cwd = makeTempDir()

    const expansion = expandImageMentions('请看 @image:./missing.png', { cwd })

    expect(expansion.prompt).toContain('@image:./missing.png')
    expect(expansion.attachments).toEqual([])
    expect(expansion.warnings[0]?.reason).toContain('图片文件不存在')
  })

  it('enforces attachment count and total byte caps', () => {
    const base = makeAttachment({ bytes: 1024 })
    const tooMany = Array.from({ length: IMAGE_ATTACHMENT_MAX_COUNT + 1 }, (_, index) =>
      makeAttachment({ ...base, id: `img-${index}`, sha256: `${index}`.padStart(64, '0') })
    )
    const countResult = mergeImageAttachments(tooMany)

    expect(countResult.attachments).toHaveLength(IMAGE_ATTACHMENT_MAX_COUNT)
    expect(countResult.warnings[0]?.reason).toContain('图片数量超过')

    const largeResult = mergeImageAttachments([
      makeAttachment({ bytes: IMAGE_ATTACHMENT_SINGLE_MAX_BYTES + 1 })
    ])
    expect(largeResult.attachments).toEqual([])
    expect(largeResult.warnings[0]?.reason).toContain('单图上限')
  })

  it('builds multimodal messages and redacts transcript copies', () => {
    const attachment = makeAttachment()
    const message = createUserMessageWithImages('看图', [attachment])

    expect(Array.isArray(message.content)).toBe(true)
    expect(message.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', image: attachment.data, mediaType: 'image/png' }
    ])

    const redacted = redactImageMessageForTranscript(message)
    expect(JSON.stringify(redacted)).not.toContain(attachment.data)
    expect(JSON.stringify(redacted)).toContain('图片附件已脱敏')
  })

  it('creates audit payload without image bodies', () => {
    const attachment = makeAttachment({
      path: 'C:\\Users\\alice\\Pictures\\secret\\debug.png',
      displayName: 'debug.png'
    })
    const payload = createUserAttachmentPayload([attachment])
    const payloadText = JSON.stringify(payload)

    expect(payloadText).not.toContain(attachment.data)
    expect(payloadText).not.toContain('alice')
    expect(payloadText).not.toContain('secret')
    expect(payload).toMatchObject({ count: 1, totalBytes: attachment.bytes })
    expect(payloadText).toContain('pathSha256')
  })
})

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'q-code-attachments-'))
}

function writePng(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
}

function makeAttachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: 'abc123',
    source: 'mention',
    path: 'debug.png',
    displayName: 'debug.png',
    mediaType: 'image/png',
    bytes: 9,
    sha256: 'a'.repeat(64),
    data: 'iVBORw0KGgo=',
    ...overrides
  }
}
