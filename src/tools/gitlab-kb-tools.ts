/**
 * GitLab Wiki 知识库工具：搜索、读取与发布页面。
 */
import {
  formatGitLabKbPage,
  formatGitLabKbPages,
  formatGitLabKbPublishResult,
  loadGitLabKbConfig,
  publishGitLabKbPage,
  readGitLabKbPage,
  searchGitLabKb
} from '../gitlab-kb'
import type { ToolDefinition, ToolExecutionContext } from './registry'

interface SearchInput {
  query?: string
  limit?: number
}

interface ReadInput {
  slug: string
}

interface PublishInput {
  title: string
  content: string
  slug?: string
}

/** 创建 gitlab_kb_search/read/publish 工具数组（未配置时 isEnabled 为 false）。 */
export function createGitLabKbTools(): ToolDefinition[] {
  return [createGitLabKbSearchTool(), createGitLabKbReadTool(), createGitLabKbPublishTool()]
}

function createGitLabKbSearchTool(): ToolDefinition {
  return {
    name: 'gitlab_kb_search',
    description:
      '搜索或列出当前仓库 GitLab Wiki 知识库页面。知识库用于企业内部共享仓库级经验、约定、FAQ 和决策',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '可选搜索词；不传时列出知识库前缀下的页面'
        },
        limit: {
          type: 'number',
          description: '最多返回条数，默认 10，最大 30'
        }
      },
      additionalProperties: false
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    allowInPlanMode: true,
    shouldDefer: true,
    searchHint: 'GitLab Wiki 仓库知识库搜索/列表',
    contextCost: 'medium',
    resultShape: 'summary',
    jitHint: '外部 GitLab Wiki 知识库，按需搜索',
    isEnabled: () => loadGitLabKbConfig().enabled,
    execute: async (input: SearchInput, context: ToolExecutionContext) => {
      const pages = await searchGitLabKb({
        cwd: context.cwd,
        query: typeof input.query === 'string' ? input.query : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
        signal: context.abortSignal
      })
      return formatGitLabKbPages(
        pages,
        input.query ? `GitLab Wiki KB Search: ${input.query}` : 'GitLab Wiki KB Pages'
      )
    }
  }
}

function createGitLabKbReadTool(): ToolDefinition {
  return {
    name: 'gitlab_kb_read',
    description: '读取当前仓库 GitLab Wiki 知识库中的单个页面。先用 gitlab_kb_search 找到 slug',
    parameters: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          minLength: 1,
          description: 'Wiki 页面 slug，例如 q-code-kb/deploy-rules'
        }
      },
      required: ['slug'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    allowInPlanMode: true,
    shouldDefer: true,
    searchHint: 'GitLab Wiki 仓库知识库读取',
    contextCost: 'high',
    resultShape: 'web',
    jitHint: '只在明确需要某个知识页全文时读取',
    isEnabled: () => loadGitLabKbConfig().enabled,
    execute: async (input: ReadInput, context: ToolExecutionContext) => {
      const slug = typeof input.slug === 'string' ? input.slug.trim() : ''
      if (!slug) return 'Error: slug 是必填项'
      return formatGitLabKbPage(
        await readGitLabKbPage({
          cwd: context.cwd,
          slug,
          signal: context.abortSignal
        })
      )
    }
  }
}

function createGitLabKbPublishTool(): ToolDefinition {
  return {
    name: 'gitlab_kb_publish',
    description:
      '把未来仍有价值的仓库级知识发布或更新到 GitLab Wiki 知识库。适合沉淀企业内部约定、排障结论、FAQ、架构决策',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          description: '知识页标题；会自动放到配置的 Wiki 前缀下'
        },
        content: {
          type: 'string',
          minLength: 1,
          description: 'Markdown 正文'
        },
        slug: {
          type: 'string',
          description: '可选页面 slug；不传时按 title 生成'
        }
      },
      required: ['title', 'content'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    shouldDefer: true,
    searchHint: 'GitLab Wiki 仓库知识库发布/更新',
    contextCost: 'medium',
    resultShape: 'mutation',
    jitHint: '只沉淀未来可复用的仓库级知识',
    isEnabled: () => loadGitLabKbConfig().enabled,
    execute: async (input: PublishInput, context: ToolExecutionContext) => {
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      const content = typeof input.content === 'string' ? input.content.trim() : ''
      const slug = typeof input.slug === 'string' ? input.slug.trim() : undefined
      if (!title || !content) return 'Error: title 和 content 都是必填项'

      return formatGitLabKbPublishResult(
        await publishGitLabKbPage({
          cwd: context.cwd,
          title,
          content,
          ...(slug ? { slug } : {}),
          signal: context.abortSignal
        })
      )
    }
  }
}
