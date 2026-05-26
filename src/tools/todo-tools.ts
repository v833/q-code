/**
 * 会话 Todo 工具：todo_write 全量替换当前会话任务清单。
 */
import {
  formatTodoList,
  getTodoStatusWarning,
  parseTodoItems,
  replaceTodos
} from '../context/todos'
import type { ToolDefinition } from './registry'

/** 注入 todo_write 所需的会话上下文。 */
export interface TodoToolController {
  getSessionId: () => string
  isEnabled?: () => boolean
}

/** 创建 `todo_write` 工具定义。 */
export function createTodoWriteTool(controller: TodoToolController): ToolDefinition {
  return {
    name: 'todo_write',
    description:
      '更新当前会话的任务清单。适合多步骤任务主动使用；每次调用都必须传入完整的新清单，替换旧清单',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的任务清单；每次调用都会全量替换旧清单',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                minLength: 1,
                description: '祈使句任务描述，例如“运行测试”'
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: '任务状态；通常应恰好一个任务为 in_progress'
              },
              activeForm: {
                type: 'string',
                minLength: 1,
                description: '当前进行时文案，例如“正在运行测试”'
              }
            },
            required: ['content', 'status', 'activeForm'],
            additionalProperties: false
          }
        }
      },
      required: ['todos'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    allowInPlanMode: true,
    contextCost: 'low',
    resultShape: 'state',
    jitHint: '维护轻量会话清单',
    isEnabled: () => controller.isEnabled?.() ?? true,
    execute: async ({ todos }: { todos: unknown }) => {
      const parsed = parseTodoItems(todos)
      if (!parsed.todos) {
        return `Error: ${parsed.error ?? 'invalid todos'}`
      }

      const sessionId = controller.getSessionId()
      const { stored, allDone } = replaceTodos(sessionId, parsed.todos)
      const warning = getTodoStatusWarning(stored)

      return [
        'Todos have been modified successfully.',
        'Ensure that you continue to use the todo list to track your progress.',
        allDone ? '所有任务已完成，任务清单已自动清空。' : formatTodoList(stored),
        warning
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n')
    }
  }
}
