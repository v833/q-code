/**
 * 保守的记忆自动提取器：只处理用户显式要求长期记住的信息。
 */
import type { ModelMessage } from 'ai'
import { shouldIgnoreMemory } from './memdir'
import type { MemoryType } from './memory-types'

/** 自动提取出的长期记忆候选。 */
export interface ExtractedMemoryCandidate {
  name: string
  description: string
  type: MemoryType
  content: string
}

const MAX_EXTRACTED_CONTENT_CHARS = 2000

/** 从最近几轮消息中提取用户显式要求保存的长期记忆。 */
export function extractExplicitMemoryCandidate(
  messages: readonly ModelMessage[],
  now: Date = new Date()
): ExtractedMemoryCandidate | null {
  const recentUserTexts = messages
    .filter((message) => message.role === 'user')
    .slice(-5)
    .map((message) => modelContentToText(message.content))
    .filter(Boolean)

  for (const text of recentUserTexts.reverse()) {
    if (shouldIgnoreMemory(text)) continue
    const extracted = extractRememberClause(text)
    if (!extracted) continue
    const content = clipExtractedContent(extracted)
    return {
      name: createCandidateName(content),
      description: '用户显式要求长期记住的信息',
      type: inferMemoryType(content),
      content: [`记录时间：${now.toISOString()}`, '', content].join('\n')
    }
  }

  return null
}

function extractRememberClause(text: string): string | null {
  const normalized = text.trim()
  const patterns = [
    /(?:请)?(?:帮我)?记住[：:，,\s]*(.+)$/is,
    /以后(?:请)?记得[：:，,\s]*(.+)$/is,
    /(?:please\s+)?remember(?:\s+that)?[：:，,\s]*(.+)$/is
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    const value = match?.[1]?.trim()
    if (value && value.length >= 6) return value
  }
  return null
}

function inferMemoryType(content: string): MemoryType {
  const lower = content.toLowerCase()
  if (/(以后你|不要|必须|请你|always|never|回复|回答|风格)/i.test(content)) return 'feedback'
  if (/(我|我的|i |my |prefer|偏好|喜欢|习惯)/i.test(content)) return 'user'
  if (/(链接|地址|url|wiki|文档|dashboard|仪表盘)/i.test(lower)) return 'reference'
  return 'project'
}

function createCandidateName(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim()
  return compact.slice(0, 28) || '长期记忆'
}

function clipExtractedContent(content: string): string {
  if (content.length <= MAX_EXTRACTED_CONTENT_CHARS) return content
  return `${content.slice(0, MAX_EXTRACTED_CONTENT_CHARS).trimEnd()}\n\n... [auto memory truncated] ...`
}

function modelContentToText(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      if ('text' in part && typeof part.text === 'string') return part.text
      return ''
    })
    .join('\n')
}
