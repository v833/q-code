/**
 * 图片附件处理：识别本地图片、校验大小/数量、构造多模态消息，并为 transcript 生成脱敏摘要。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import type { ImagePart, ModelMessage, TextPart } from 'ai'
import { isTrueEnv } from '../utils/env'
import { resolveShellInvocation } from '../runtime/shell-invocation'

export const IMAGE_ATTACHMENT_MAX_COUNT = 4
export const IMAGE_ATTACHMENT_SINGLE_MAX_BYTES = 10 * 1024 * 1024
export const IMAGE_ATTACHMENT_TOTAL_MAX_BYTES = 20 * 1024 * 1024

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])
const IMAGE_AT_TOKEN_RE = /@image:(?:"([^"]+)"|'([^']+)'|(\S+))/g

export interface ImageAttachment {
  id: string
  source: 'clipboard' | 'path' | 'mention' | 'acp'
  path: string
  displayName: string
  mediaType: string
  bytes: number
  sha256: string
  data: string
}

export interface ImageAttachmentSummary {
  id: string
  source: ImageAttachment['source']
  path: string
  displayName: string
  mediaType: string
  bytes: number
  sha256: string
}

export interface ImageAttachmentWarning {
  raw: string
  reason: string
}

export interface ImageAttachmentExtraction {
  prompt: string
  attachments: ImageAttachment[]
  warnings: ImageAttachmentWarning[]
}

export interface PrepareImageAttachmentOptions {
  cwd: string
  source: ImageAttachment['source']
  allowAbsolute?: boolean
}

export interface ExpandImageMentionsOptions {
  cwd: string
  existingAttachments?: readonly ImageAttachment[]
  allowAbsolute?: boolean
}

export interface ClipboardImageReadResult {
  attachment?: ImageAttachment
  error?: string
}

/** 判断路径扩展名是否属于当前支持的图片类型。 */
export function isSupportedImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(stripWrappingQuotes(filePath)).toLowerCase())
}

/** 提取单行粘贴中的本地图片路径；不命中时返回 undefined。 */
export function detectPastedImagePath(input: string): string | undefined {
  const text = stripWrappingQuotes(input.trim())
  if (!text || /[\r\n]/.test(text)) return undefined
  if (!isAbsolute(text)) return undefined
  if (!isSupportedImagePath(text)) return undefined
  if (!existsSync(text)) return undefined
  try {
    if (!statSync(text).isFile()) return undefined
  } catch {
    return undefined
  }
  return text
}

/** 从本地图片文件构造附件；只把图片数据留在内存中的下一轮请求里。 */
export function prepareImageAttachment(
  inputPath: string,
  options: PrepareImageAttachmentOptions
): ImageAttachment {
  const cwd = resolve(options.cwd)
  const allowAbsolute = options.allowAbsolute ?? isTrueEnv(process.env.Q_CODE_MENTION_ALLOW_ABS)
  const displayInput = stripWrappingQuotes(inputPath.trim())
  const absolutePath = resolveAttachmentPath(cwd, displayInput, allowAbsolute)

  if (!existsSync(absolutePath)) throw new Error(`图片文件不存在: ${displayInput}`)
  assertRealPathAllowed(cwd, absolutePath, displayInput, allowAbsolute)

  const stat = statSync(absolutePath)
  if (!stat.isFile()) throw new Error(`路径不是文件: ${displayInput}`)
  if (stat.size > IMAGE_ATTACHMENT_SINGLE_MAX_BYTES) {
    throw new Error(
      `图片超过单图上限 ${formatBytes(IMAGE_ATTACHMENT_SINGLE_MAX_BYTES)}: ${formatBytes(stat.size)}`
    )
  }
  if (!isSupportedImagePath(absolutePath)) throw new Error(`不支持的图片类型: ${displayInput}`)

  return createImageAttachment({
    absolutePath,
    data: readFileSync(absolutePath),
    displayInput,
    source: options.source
  })
}

/** 从 ACP 等外部协议提供的 base64 数据构造内存图片附件，不落盘。 */
export function createImageAttachmentFromData(
  data: string,
  options: { mediaType: string; displayName?: string; source?: 'acp' }
): ImageAttachment {
  const normalizedData = data.trim()
  if (!normalizedData) throw new Error('图片数据不能为空')
  const compactData = normalizedData.replace(/\s+/g, '')
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(compactData) || compactData.length % 4 === 1) {
    throw new Error('图片数据不是有效的 base64')
  }
  const bytes = Buffer.from(compactData, 'base64')
  if (bytes.length === 0) throw new Error('图片数据不是有效的 base64')
  const canonical = bytes.toString('base64').replace(/=+$/, '')
  if (canonical !== compactData.replace(/=+$/, '')) {
    throw new Error('图片数据不是有效的 base64')
  }
  if (bytes.length > IMAGE_ATTACHMENT_SINGLE_MAX_BYTES) {
    throw new Error(
      `图片超过单图上限 ${formatBytes(IMAGE_ATTACHMENT_SINGLE_MAX_BYTES)}: ${formatBytes(bytes.length)}`
    )
  }

  const detectedMediaType = detectImageMediaType(bytes) ??
    (options.mediaType === 'image/svg+xml' && looksLikeSvg(bytes) ? 'image/svg+xml' : undefined)
  if (!detectedMediaType || detectedMediaType !== options.mediaType) {
    throw new Error(`图片 media type 与内容不匹配: ${options.mediaType}`)
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const displayName = options.displayName?.trim() || `acp-${sha256.slice(0, 12)}`
  return {
    id: sha256.slice(0, 12),
    source: options.source ?? 'acp',
    path: `acp://${sha256.slice(0, 16)}/${displayName}`,
    displayName,
    mediaType: detectedMediaType,
    bytes: bytes.length,
    sha256,
    data: normalizedData
  }
}

/** 异步读取本地图片文件，适合 TUI 输入路径等交互热路径。 */
export async function prepareImageAttachmentAsync(
  inputPath: string,
  options: PrepareImageAttachmentOptions
): Promise<ImageAttachment> {
  const cwd = resolve(options.cwd)
  const allowAbsolute = options.allowAbsolute ?? isTrueEnv(process.env.Q_CODE_MENTION_ALLOW_ABS)
  const displayInput = stripWrappingQuotes(inputPath.trim())
  const absolutePath = resolveAttachmentPath(cwd, displayInput, allowAbsolute)

  if (!existsSync(absolutePath)) throw new Error(`图片文件不存在: ${displayInput}`)
  await assertRealPathAllowedAsync(cwd, absolutePath, displayInput, allowAbsolute)

  const fileStat = await stat(absolutePath)
  if (!fileStat.isFile()) throw new Error(`路径不是文件: ${displayInput}`)
  if (fileStat.size > IMAGE_ATTACHMENT_SINGLE_MAX_BYTES) {
    throw new Error(
      `图片超过单图上限 ${formatBytes(IMAGE_ATTACHMENT_SINGLE_MAX_BYTES)}: ${formatBytes(fileStat.size)}`
    )
  }
  if (!isSupportedImagePath(absolutePath)) throw new Error(`不支持的图片类型: ${displayInput}`)

  return createImageAttachment({
    absolutePath,
    data: await readFile(absolutePath),
    displayInput,
    source: options.source
  })
}

/** 展开 `@image:<path>` token，并返回移除 token 后的 prompt 与附件列表。 */
export function expandImageMentions(
  input: string,
  options: ExpandImageMentionsOptions
): ImageAttachmentExtraction {
  const attachments: ImageAttachment[] = []
  const warnings: ImageAttachmentWarning[] = []
  const existing = options.existingAttachments ?? []
  let totalBytes = existing.reduce((sum, item) => sum + item.bytes, 0)
  let index = 0

  const prompt = input.replace(IMAGE_AT_TOKEN_RE, (raw, doubleQuoted, singleQuoted, bare) => {
    const target = String(doubleQuoted ?? singleQuoted ?? bare ?? '').trim()
    if (!target) {
      warnings.push({ raw, reason: '空图片路径' })
      return raw
    }
    if (existing.length + attachments.length >= IMAGE_ATTACHMENT_MAX_COUNT) {
      warnings.push({ raw, reason: `图片数量超过 ${IMAGE_ATTACHMENT_MAX_COUNT} 张上限，已忽略` })
      return ''
    }
    try {
      const attachment = prepareImageAttachment(target, {
        cwd: options.cwd,
        source: 'mention',
        ...(options.allowAbsolute !== undefined ? { allowAbsolute: options.allowAbsolute } : {})
      })
      if (totalBytes + attachment.bytes > IMAGE_ATTACHMENT_TOTAL_MAX_BYTES) {
        warnings.push({
          raw,
          reason: `图片附件总量超过 ${formatBytes(IMAGE_ATTACHMENT_TOTAL_MAX_BYTES)}，已忽略`
        })
        return ''
      }
      totalBytes += attachment.bytes
      attachments.push({ ...attachment, id: `${attachment.id}-${index++}` })
      return ''
    } catch (error) {
      warnings.push({ raw, reason: error instanceof Error ? error.message : String(error) })
      return raw
    }
  })

  return {
    prompt: prompt.replace(/[ \t]{2,}/g, ' ').trimEnd(),
    attachments,
    warnings
  }
}

/** 校验并合并来自 TUI 和 `@image:` 的附件。 */
export function mergeImageAttachments(
  attachments: readonly ImageAttachment[]
): { attachments: ImageAttachment[]; warnings: ImageAttachmentWarning[] } {
  const accepted: ImageAttachment[] = []
  const warnings: ImageAttachmentWarning[] = []
  let totalBytes = 0
  for (const attachment of attachments) {
    if (accepted.length >= IMAGE_ATTACHMENT_MAX_COUNT) {
      warnings.push({
        raw: attachment.displayName,
        reason: `图片数量超过 ${IMAGE_ATTACHMENT_MAX_COUNT} 张上限，已忽略`
      })
      continue
    }
    if (attachment.bytes > IMAGE_ATTACHMENT_SINGLE_MAX_BYTES) {
      warnings.push({
        raw: attachment.displayName,
        reason: `图片超过单图上限 ${formatBytes(IMAGE_ATTACHMENT_SINGLE_MAX_BYTES)}`
      })
      continue
    }
    if (totalBytes + attachment.bytes > IMAGE_ATTACHMENT_TOTAL_MAX_BYTES) {
      warnings.push({
        raw: attachment.displayName,
        reason: `图片附件总量超过 ${formatBytes(IMAGE_ATTACHMENT_TOTAL_MAX_BYTES)}，已忽略`
      })
      continue
    }
    totalBytes += attachment.bytes
    accepted.push(attachment)
  }
  return { attachments: accepted, warnings }
}

/** 构造发送给模型的 user message：文字与图片保持在同一条消息内。 */
export function createUserMessageWithImages(
  text: string,
  attachments: readonly ImageAttachment[]
): ModelMessage {
  if (attachments.length === 0) return { role: 'user', content: text }
  const parts: Array<TextPart | ImagePart> = []
  if (text.trim()) parts.push({ type: 'text', text })
  for (const attachment of attachments) {
    parts.push({
      type: 'image',
      image: attachment.data,
      mediaType: attachment.mediaType
    })
  }
  return { role: 'user', content: parts }
}

/** 生成不含图片正文的 transcript 消息，避免 base64 落盘。 */
export function redactImageMessageForTranscript(message: ModelMessage): ModelMessage {
  if (!Array.isArray(message.content)) return message
  const content = message.content.map((part) => {
    if (isImagePart(part)) {
      return {
        type: 'text' as const,
        text: `[图片附件已脱敏: mediaType=${part.mediaType ?? 'image/*'}]`
      }
    }
    return part
  })
  return { ...message, content } as ModelMessage
}

/** 为审计日志生成图片附件摘要，不包含 base64 正文。 */
export function createUserAttachmentPayload(
  attachments: readonly ImageAttachment[]
): Record<string, unknown> {
  return {
    count: attachments.length,
    totalBytes: attachments.reduce((sum, item) => sum + item.bytes, 0),
    attachments: attachments.map((item) => ({
      source: item.source,
      name: item.displayName,
      mediaType: item.mediaType,
      bytes: item.bytes,
      sha256: item.sha256,
      pathSha256: createHash('sha256').update(item.path).digest('hex')
    }))
  }
}

/** TUI 展示用摘要。 */
export function summarizeImageAttachment(attachment: ImageAttachment): ImageAttachmentSummary {
  return {
    id: attachment.id,
    source: attachment.source,
    path: attachment.path,
    displayName: attachment.displayName,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    sha256: attachment.sha256
  }
}

/** 读取系统剪贴板中的图片；当前 Windows 使用 PowerShell，其他平台返回降级提示。 */
export async function readClipboardImageAttachment(options: {
  cwd: string
  sessionId: string
}): Promise<ClipboardImageReadResult> {
  if (process.platform !== 'win32') {
    return { error: '当前平台暂未内置剪贴板图片读取，请保存为文件后使用 @image:<path>。' }
  }
  const outDir = join(getQCodeHome(), 'clips', options.sessionId)
  mkdirSync(outDir, { recursive: true })
  const target = join(outDir, `clipboard-${Date.now()}.png`)
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$image = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $image) { exit 3 }',
    `$image.Save(${JSON.stringify(target)}, [System.Drawing.Imaging.ImageFormat]::Png)`
  ].join('; ')
  const { spawn } = await import('node:child_process')
  const shell = resolveShellInvocation(script, { platform: 'win32' })
  if (!shell.ok) return { error: shell.unavailableMessage }
  const exitCode = await new Promise<number>((resolveExit) => {
    const child = spawn(shell.shell.command, shell.shell.args, {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.on('error', () => resolveExit(127))
    child.on('exit', (code) => resolveExit(code ?? 1))
  })
  if (exitCode === 3) return { error: '剪贴板中没有可读取的图片。' }
  if (exitCode !== 0 || !existsSync(target)) {
    return { error: '读取剪贴板图片失败，请保存为文件后使用 @image:<path>。' }
  }
  try {
    return {
      attachment: prepareImageAttachment(target, {
        cwd: options.cwd,
        source: 'clipboard',
        allowAbsolute: true
      })
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** 在调试关闭时清理本会话剪贴板临时图片。 */
export function cleanupClipboardImages(sessionId: string): void {
  if (isTrueEnv(process.env.Q_CODE_KEEP_CLIPS)) return
  const dir = join(getQCodeHome(), 'clips', sessionId)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 清理失败不应影响主流程。
  }
}

/** 根据 magic number 和扩展名识别图片 media type。 */
export function detectImageMediaType(data: Uint8Array, filePath = ''): string | undefined {
  if (hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (hasPrefix(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (hasPrefix(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (hasPrefix(data, [0x42, 0x4d])) return 'image/bmp'
  if (isWebp(data)) return 'image/webp'
  const ext = extname(filePath).toLowerCase()
  if (ext === '.svg') return 'image/svg+xml'
  return undefined
}

/** 格式化附件大小。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}

function resolveAttachmentPath(cwd: string, inputPath: string, allowAbsolute: boolean): string {
  if (isAbsolute(inputPath) && !allowAbsolute) {
    throw new Error(
      `绝对路径默认被阻止: ${inputPath}。若确实需要引用绝对路径，请设置 Q_CODE_MENTION_ALLOW_ABS=true。`
    )
  }
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
  if (!isInsideDirectory(cwd, absolutePath) && !(allowAbsolute && isAbsolute(inputPath))) {
    throw new Error(`路径越界: ${inputPath} 不在当前工作目录内`)
  }
  return absolutePath
}

function assertRealPathAllowed(
  cwd: string,
  absolutePath: string,
  inputPath: string,
  allowAbsolute: boolean
): void {
  const realRoot = realpathSync.native(resolve(cwd))
  const realTarget = realpathSync.native(absolutePath)
  if (!isInsideDirectory(realRoot, realTarget) && !(allowAbsolute && isAbsolute(inputPath))) {
    throw new Error(`路径越界: ${inputPath} 指向当前工作目录外的真实路径`)
  }
}

async function assertRealPathAllowedAsync(
  cwd: string,
  absolutePath: string,
  inputPath: string,
  allowAbsolute: boolean
): Promise<void> {
  const realRoot = await realpath(resolve(cwd))
  const realTarget = await realpath(absolutePath)
  if (!isInsideDirectory(realRoot, realTarget) && !(allowAbsolute && isAbsolute(inputPath))) {
    throw new Error(`路径越界: ${inputPath} 指向当前工作目录外的真实路径`)
  }
}

function createImageAttachment(args: {
  absolutePath: string
  data: Uint8Array
  displayInput: string
  source: ImageAttachment['source']
}): ImageAttachment {
  const mediaType = detectImageMediaType(args.data, args.absolutePath)
  if (!mediaType) throw new Error(`无法识别图片类型: ${args.displayInput}`)
  const sha256 = createHash('sha256').update(args.data).digest('hex')

  return {
    id: sha256.slice(0, 12),
    source: args.source,
    path: args.absolutePath,
    displayName: basename(args.absolutePath),
    mediaType,
    bytes: args.data.byteLength,
    sha256,
    data: Buffer.from(args.data).toString('base64')
  }
}

function isInsideDirectory(root: string, target: string): boolean {
  const normalizedRoot = normalizeForCompare(resolve(root))
  const normalizedTarget = normalizeForCompare(resolve(target))
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`)
  )
}

function normalizeForCompare(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function hasPrefix(data: Uint8Array, prefix: number[]): boolean {
  if (data.length < prefix.length) return false
  return prefix.every((byte, index) => data[index] === byte)
}

function isWebp(data: Uint8Array): boolean {
  return (
    data.length >= 12 &&
    String.fromCharCode(...data.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...data.slice(8, 12)) === 'WEBP'
  )
}

function looksLikeSvg(data: Uint8Array): boolean {
  const prefix = Buffer.from(data.slice(0, 1024)).toString('utf8')
  return /<svg(?:\s|>)/i.test(prefix)
}

function isImagePart(part: unknown): part is ImagePart {
  return Boolean(part && typeof part === 'object' && 'type' in part && part.type === 'image')
}

function getQCodeHome(): string {
  return resolve(process.env.Q_CODE_HOME?.trim() || join(homedir(), '.q-code'))
}
