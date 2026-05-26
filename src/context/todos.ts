/**
 * 会话级 Todo 清单（TodoWrite V1）：内存存储、校验、订阅与格式化输出。
 */

/** Todo 项状态。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** 单条 Todo 项。 */
export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm: string
}

/** `parseTodoItems` 的解析结果：成功时含 todos，失败时含 error。 */
export interface TodoValidationResult {
  todos?: TodoItem[]
  error?: string
}

type TodoListener = (sessionId: string, todos: TodoItem[]) => void

const VALID_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed'])
const todosBySession = new Map<string, TodoItem[]>()
const listeners = new Set<TodoListener>()

/**
 * 校验并解析工具传入的 todos 数组。
 * @param value 原始工具参数
 */
export function parseTodoItems(value: unknown): TodoValidationResult {
  if (!Array.isArray(value)) {
    return { error: '`todos` must be an array.' }
  }

  const todos: TodoItem[] = []
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (!isRecord(item)) {
      return { error: `todos[${i}] must be an object.` }
    }

    const content = normalizeText(item.content)
    const activeForm = normalizeText(item.activeForm)
    const status = item.status
    if (!content || !activeForm || !VALID_STATUSES.has(status as TodoStatus)) {
      return {
        error:
          `todos[${i}] must include non-empty content, non-empty activeForm, ` +
          'and status pending|in_progress|completed.'
      }
    }

    todos.push({
      content,
      activeForm,
      status: status as TodoStatus
    })
  }

  return { todos }
}

/**
 * 返回指定会话的 Todo 副本（无则空数组）。
 * @param sessionId 会话 ID
 */
export function getTodos(sessionId: string): TodoItem[] {
  return cloneTodos(todosBySession.get(sessionId) ?? [])
}

/**
 * 全量替换会话 Todo 列表；全部 completed 时自动清空存储。
 * @param sessionId 会话 ID
 * @param todos 完整新列表
 * @returns stored 为实际存储的副本，allDone 表示是否因全部完成而清空
 */
export function replaceTodos(
  sessionId: string,
  todos: TodoItem[]
): { stored: TodoItem[]; allDone: boolean } {
  // TodoWrite V1 为全量替换，避免模型跨轮维护合成 id
  const allDone = todos.length > 0 && todos.every((todo) => todo.status === 'completed')
  const stored = allDone ? [] : cloneTodos(todos)
  todosBySession.set(sessionId, stored)
  notify(sessionId, stored)
  return { stored: cloneTodos(stored), allDone }
}

/** 清空指定会话的 Todo 并通知订阅者。 */
export function clearTodos(sessionId: string): void {
  todosBySession.set(sessionId, [])
  notify(sessionId, [])
}

/**
 * 订阅 Todo 变更；返回取消订阅函数。
 * @param listener 变更回调
 */
export function subscribeTodos(listener: TodoListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 将 Todo 列表格式化为面向用户/模型的多行文本。 */
export function formatTodoList(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return 'Todos: 当前没有任务。'

  const done = todos.filter((todo) => todo.status === 'completed').length
  const lines = [`Todos (${done}/${todos.length} done)`]
  for (const todo of todos) {
    if (todo.status === 'completed') {
      lines.push(`  [x] ${todo.content}`)
    } else if (todo.status === 'in_progress') {
      lines.push(`  [>] ${todo.activeForm}`)
    } else {
      lines.push(`  [ ] ${todo.content}`)
    }
  }
  return lines.join('\n')
}

/**
 * 当 in_progress 数量不为 1 时返回中文提示，否则返回 null。
 */
export function getTodoStatusWarning(todos: readonly TodoItem[]): string | null {
  if (todos.length === 0) return null
  const inProgressCount = todos.filter((todo) => todo.status === 'in_progress').length
  if (inProgressCount === 1) return null
  return `提示：当前有 ${inProgressCount} 个 in_progress；通常应保持恰好 1 个。`
}

function notify(sessionId: string, todos: TodoItem[]): void {
  const snapshot = cloneTodos(todos)
  for (const listener of listeners) listener(sessionId, snapshot)
}

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }))
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
