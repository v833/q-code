/**
 * 项目记忆写入工具：memory_write 写入 `.q-code/memdir`。
 */
import { isMemoryType } from '../context/memory/memory-types'
import { writeProjectMemory } from '../context/memory/memdir'
import type { ToolDefinition, ToolExecutionContext } from './registry'

interface MemoryWriteInput {
  name: string
  description: string
  type: string
  content: string
  fileName?: string
}

/** 将结构化记忆写入项目 memdir 并更新索引。 */
export const memoryWriteTool: ToolDefinition = {
  name: 'memory_write',
  description:
    '保存跨对话仍然有用的项目记忆。只记录不能从当前仓库直接推导、未来会影响协作或判断的信息',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '简短记忆标题' },
      description: { type: 'string', description: '写入 MEMORY.md 的一行索引说明' },
      type: {
        type: 'string',
        enum: ['user', 'feedback', 'project', 'reference'],
        description: '记忆类型：user / feedback / project / reference'
      },
      content: { type: 'string', description: '完整 Markdown 记忆正文' },
      fileName: { type: 'string', description: '可选目标文件名，例如 deploy-rules.md' }
    },
    required: ['name', 'description', 'type', 'content'],
    additionalProperties: false
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  contextCost: 'medium',
  resultShape: 'mutation',
  jitHint: '只记录未来仍有用的信息',
  execute: async (input: MemoryWriteInput, context: ToolExecutionContext) => {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const description = typeof input.description === 'string' ? input.description.trim() : ''
    const content = typeof input.content === 'string' ? input.content.trim() : ''
    const fileName = typeof input.fileName === 'string' ? input.fileName.trim() : undefined

    if (!name || !description || !content || !isMemoryType(input.type)) {
      return 'Error: name、description、content 和合法 type 都是必填项'
    }

    const result = await writeProjectMemory({
      cwd: context.cwd,
      name,
      description,
      type: input.type,
      content,
      ...(fileName ? { fileName } : {})
    })

    return result.updatedExisting
      ? `已更新 ${input.type} 记忆: ${result.fileName}\n${result.filePath}`
      : `已保存 ${input.type} 记忆: ${result.fileName}\n${result.filePath}`
  }
}
