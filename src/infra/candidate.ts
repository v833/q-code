/**
 * 通过 MCP 向企业知识库提交候选知识（`/infra candidate`）。
 *
 * 解析斜杠命令参数、查找 `submit_knowledge_candidate` 工具并组装 payload。
 */
import { collectRepoInfo } from './git-info'
import type { InfraRepoInfo } from './types'
import type { ToolDefinition, ToolRegistry } from '../tools/registry'

/** 候选知识类型，与管理端枚举一致。 */
export type KnowledgeCandidateType = 'pitfall' | 'decision' | 'faq' | 'requirement_case' | 'convention'

/** {@link submitInfraKnowledgeCandidate} 的输入。 */
export interface SubmitKnowledgeCandidateOptions {
  cwd: string
  registry: ToolRegistry
  /** 斜杠命令去掉子命令后的参数字符串 */
  args: string
}

/** 候选知识提交结果。 */
export interface SubmitKnowledgeCandidateResult {
  ok: boolean
  message: string
  toolName?: string
  candidateId?: string
  status?: string
  reviewPriority?: string
}

interface ParsedCandidateArgs {
  type: KnowledgeCandidateType
  title?: string
  content: string
  repo?: string
  domainId?: string
}

const DEFAULT_CANDIDATE_TYPE: KnowledgeCandidateType = 'faq'
const CANDIDATE_TYPES = new Set<KnowledgeCandidateType>([
  'pitfall',
  'decision',
  'faq',
  'requirement_case',
  'convention'
])
const SUBMIT_TOOL_SUFFIX = '__submit_knowledge_candidate'
const PREFERRED_SUBMIT_TOOL = `mcp__enterprise_kb${SUBMIT_TOOL_SUFFIX}`

/**
 * 解析参数并调用 MCP 工具提交候选知识。
 *
 * @param options - 工作目录、工具注册表与原始参数字符串
 */
export async function submitInfraKnowledgeCandidate(
  options: SubmitKnowledgeCandidateOptions
): Promise<SubmitKnowledgeCandidateResult> {
  const parsed = parseKnowledgeCandidateArgs(options.args)
  if (!parsed) {
    return {
      ok: false,
      message: [
        '用法: /infra candidate [--type faq|pitfall|decision|requirement_case|convention] [--title 标题] [--domain domainId] [--repo repo] <候选知识正文>',
        '示例: /infra candidate --type pitfall --title "tsconfig 类型报错" tsconfig 只配置 react 时可能触发 react-native 类型解析问题。'
      ].join('\n')
    }
  }

  const tool = resolveSubmitCandidateTool(options.registry)
  if (!tool) {
    return {
      ok: false,
      message: '未找到 MCP 工具 submit_knowledge_candidate。请先配置并连接 enterprise_kb，然后运行 /mcp reconnect enterprise_kb。'
    }
  }

  const repoInfo = await collectRepoInfo(options.cwd)
  const payload = buildCandidatePayload(parsed, repoInfo)
  const output = await tool.execute(payload, { cwd: options.cwd })
  const response = parseToolJson(output)

  if (response.status === 'disabled') {
    return {
      ok: false,
      toolName: tool.name,
      status: response.status,
      message: `候选知识提交被服务端关闭: ${response.error ?? 'candidate_write_disabled'}`
    }
  }

  if (!response.candidateId) {
    return {
      ok: false,
      toolName: tool.name,
      message: `候选知识提交未返回 candidateId: ${typeof output === 'string' ? output : JSON.stringify(output)}`
    }
  }

  return {
    ok: true,
    toolName: tool.name,
    candidateId: response.candidateId,
    status: response.status,
    reviewPriority: response.reviewPriority,
    message: `候选知识已提交: ${response.candidateId} (${response.status}, priority=${response.reviewPriority ?? 'unknown'})`
  }
}

/**
 * 解析 `/infra candidate` 参数字符串。
 *
 * 支持引号、`\` 转义及 `--type` / `--title` / `--repo` / `--domain` 选项。
 *
 * @returns 解析成功时的结构化参数；否则 `null`
 */
export function parseKnowledgeCandidateArgs(input: string): ParsedCandidateArgs | null {
  const tokens = tokenizeArgs(input)
  if (tokens.length === 0) return null

  let type: KnowledgeCandidateType = DEFAULT_CANDIDATE_TYPE
  let title: string | undefined
  let repo: string | undefined
  let domainId: string | undefined
  const contentParts: string[] = []

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const next = tokens[index + 1]

    if (token === '--type' || token === '-t') {
      if (!next || !isCandidateType(next)) return null
      type = next
      index++
      continue
    }
    if (token.startsWith('--type=')) {
      const value = token.slice('--type='.length)
      if (!isCandidateType(value)) return null
      type = value
      continue
    }
    if (token === '--title') {
      if (!next) return null
      title = next
      index++
      continue
    }
    if (token.startsWith('--title=')) {
      title = token.slice('--title='.length).trim()
      if (!title) return null
      continue
    }
    if (token === '--repo') {
      if (!next) return null
      repo = next
      index++
      continue
    }
    if (token.startsWith('--repo=')) {
      repo = token.slice('--repo='.length).trim()
      if (!repo) return null
      continue
    }
    if (token === '--domain') {
      if (!next) return null
      domainId = next
      index++
      continue
    }
    if (token.startsWith('--domain=')) {
      domainId = token.slice('--domain='.length).trim()
      if (!domainId) return null
      continue
    }
    if (token.startsWith('-')) return null
    contentParts.push(token)
  }

  const content = contentParts.join(' ').trim()
  if (!content) return null
  return {
    type,
    title: title || summarizeTitle(content),
    content,
    ...(repo ? { repo } : {}),
    ...(domainId ? { domainId } : {})
  }
}

function resolveSubmitCandidateTool(registry: ToolRegistry): ToolDefinition | undefined {
  const preferred = registry.searchTools(PREFERRED_SUBMIT_TOOL)[0] ?? registry.get(PREFERRED_SUBMIT_TOOL)
  if (preferred) return preferred

  const candidates = registry.getAll().filter((tool) => tool.name.endsWith(SUBMIT_TOOL_SUFFIX))
  if (candidates.length === 0) return undefined
  const [tool] = candidates.sort((a, b) => a.name.localeCompare(b.name))
  registry.searchTools(tool.name)
  return tool
}

function buildCandidatePayload(parsed: ParsedCandidateArgs, repoInfo: InfraRepoInfo): Record<string, unknown> {
  const repo = parsed.repo ?? formatRepo(repoInfo)
  return {
    type: parsed.type,
    title: parsed.title,
    content: parsed.content,
    ...(repo ? { repo } : {}),
    ...(parsed.domainId ? { domainId: parsed.domainId } : {}),
    source: {
      type: 'q-code',
      cwd: repoInfo.cwd,
      branch: repoInfo.branch,
      commit: repoInfo.commit,
      isDirty: repoInfo.isDirty
    }
  }
}

function formatRepo(repoInfo: InfraRepoInfo): string | undefined {
  if (repoInfo.remoteHost && repoInfo.group && repoInfo.name) {
    return `${repoInfo.remoteHost}/${repoInfo.group}/${repoInfo.name}`
  }
  return repoInfo.remoteUrl
}

function parseToolJson(output: unknown): Record<string, string | undefined> {
  if (typeof output !== 'string') {
    return isRecord(output) ? (output as Record<string, string | undefined>) : {}
  }
  const candidates = [output, ...extractJsonObjects(output)]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (isRecord(parsed)) return parsed as Record<string, string | undefined>
    } catch {
      /* 尝试下一个 JSON 片段 */
    }
  }
  return {}
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaping = false

  for (const char of input.trim()) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (escaping) current += '\\'
  if (quote) return []
  if (current) tokens.push(current)
  return tokens
}

function summarizeTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 48)}...`
}

/** 从混合文本中提取顶层 `{...}` JSON 对象字符串（用于解析 MCP 工具输出）。 */
function extractJsonObjects(text: string): string[] {
  const results: string[] = []
  let depth = 0
  let start = -1
  let quote: '"' | undefined
  let escaping = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (escaping) {
        escaping = false
      } else if (char === '\\') {
        escaping = true
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '"') {
      quote = '"'
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (char === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, index + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }

  return results
}

function isCandidateType(value: string): value is KnowledgeCandidateType {
  return CANDIDATE_TYPES.has(value as KnowledgeCandidateType)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
