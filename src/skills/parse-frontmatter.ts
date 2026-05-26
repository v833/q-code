/**
 * SKILL.md frontmatter 解析：YAML 分割、字段规范化与描述回退。
 */
import { parse as parseYaml } from 'yaml'
import type { SkillFrontmatter } from './types'

/** `splitFrontmatter` 的解析结果。 */
export interface FrontmatterSplit {
  raw: Record<string, unknown>
  body: string
  parseError?: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** 从 SKILL.md 全文分离 YAML frontmatter 与正文。 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return { raw: {}, body: content }

  const [, yamlText, body] = match
  try {
    const parsed = parseYaml(yamlText) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { raw: parsed as Record<string, unknown>, body }
    }
    return {
      raw: {},
      body,
      parseError: 'Frontmatter must be a YAML mapping (key: value)'
    }
  } catch (error) {
    return {
      raw: {},
      body,
      parseError: error instanceof Error ? error.message : String(error)
    }
  }
}

/** 将原始 YAML 映射为 {@link SkillFrontmatter}（含 kebab-case 别名）。 */
export function normalizeFrontmatter(
  raw: Record<string, unknown>,
  body: string
): SkillFrontmatter {
  const paths = asStringArray(raw.paths)
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    whenToUse: asString(raw.when_to_use ?? raw.whenToUse),
    allowedTools: asStringArray(raw['allowed-tools'] ?? raw.allowedTools),
    argumentHint: asString(raw['argument-hint'] ?? raw.argumentHint),
    disableModelInvocation: asBoolean(
      raw['disable-model-invocation'] ?? raw.disableModelInvocation
    ),
    paths: paths.length > 0 ? paths : undefined,
    hasForkContext: asString(raw.context) === 'fork',
    raw
  }
}

/** 当 frontmatter 无 description 时，从正文首段提取简短描述。 */
export function extractFallbackDescription(body: string): string | undefined {
  const lines = body.split(/\r?\n/)
  const buffer: string[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      if (buffer.length > 0) break
      continue
    }
    if (buffer.length === 0 && line.startsWith('#')) continue
    buffer.push(line)
  }

  const description = buffer.join(' ').replace(/\s+/g, ' ').trim()
  return description || undefined
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : undefined))
      .filter((item): item is string => Boolean(item))
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === 'yes' || normalized === '1'
}
