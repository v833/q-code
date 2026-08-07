/** ACP prompt 内容到 q-code 文本与图片附件的安全转换。 */
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'node:path'
import type { ContentBlock, PromptRequest } from '@agentclientprotocol/sdk'
import {
  createImageAttachmentFromData,
  type ImageAttachment
} from '../attachments'
import { formatFileMentionTarget } from '../mentions'

export interface AcpPromptContent {
  prompt: string
  imageAttachments: ImageAttachment[]
}

/** 把 ACP `session/prompt` 内容转换为现有 headless 输入。 */
export function convertAcpPromptContent(
  request: Pick<PromptRequest, 'prompt'>,
  cwd: string
): AcpPromptContent {
  const textParts: string[] = []
  const images: ImageAttachment[] = []

  for (const block of request.prompt) {
    switch (block.type) {
      case 'text':
        if (block.text.trim()) textParts.push(block.text)
        break
      case 'image':
        images.push(
          createImageAttachmentFromData(block.data, {
            mediaType: block.mimeType,
            displayName: block.uri ? `acp-${block.uri.split('/').at(-1) ?? 'image'}` : undefined,
            source: 'acp'
          })
        )
        break
      case 'resource_link':
        textParts.push(formatResourceLink(block, cwd))
        break
      case 'resource':
        throw new Error('ACP embedded resource 暂未支持，请改用 text 或 resource_link')
      case 'audio':
        throw new Error('ACP audio 内容暂未支持')
    }
  }

  return {
    prompt: textParts.join('\n\n').trim(),
    imageAttachments: images
  }
}

function formatResourceLink(
  block: Extract<ContentBlock, { type: 'resource_link' }>,
  cwd: string
): string {
  if (block.uri.startsWith('file://')) {
    let target: string
    try {
      target = fileURLToPath(block.uri)
    } catch {
      throw new Error(`ACP resource_link URI 无效: ${block.uri}`)
    }
    const absoluteTarget = resolve(target)
    const absoluteCwd = resolve(cwd)
    if (!isInsideDirectory(absoluteCwd, absoluteTarget)) {
      throw new Error(`ACP resource_link 超出工作目录: ${block.uri}`)
    }
    return formatFileMentionTarget(relative(absoluteCwd, absoluteTarget))
  }

  const label = block.title?.trim() || block.name.trim() || 'resource'
  const description = block.description?.trim()
  return `[ACP resource: ${label}] ${block.uri}${description ? `\n${description}` : ''}`
}

function isInsideDirectory(root: string, target: string): boolean {
  const normalizedRoot = normalizeForCompare(root)
  const normalizedTarget = normalizeForCompare(target)
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`)
  )
}

function normalizeForCompare(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
