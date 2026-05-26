/**
 * 任务图工具：TaskCreate/Update/Get/List，对接 context/tasks 持久化。
 */
import {
  blockTask,
  createTask,
  deleteTask,
  formatTaskDetail,
  formatTaskList,
  formatMarkdownInline,
  getTask,
  listTasks,
  resetTaskGraph,
  TASK_STATUSES,
  updateTask,
  type Task,
  type TaskGraphOptions,
  type TaskMode,
  type TaskStatus
} from '../context/tasks'
import type { ToolDefinition } from './registry'

/** Task 工具所需的会话与 cwd 上下文。 */
export interface TaskToolController {
  getSessionId: () => string
  getCwd: () => string
  getTaskMode: () => TaskMode
}

type UpdateStatus = TaskStatus | 'deleted'

const UPDATE_STATUSES = new Set<string>([...TASK_STATUSES, 'deleted'])

/** 创建任务图 CRUD 工具集合。 */
export function createTaskTools(controller: TaskToolController): ToolDefinition[] {
  return [
    createTaskCreateTool(controller),
    createTaskUpdateTool(controller),
    createTaskGetTool(controller),
    createTaskListTool(controller)
  ]
}

function createTaskCreateTool(controller: TaskToolController): ToolDefinition {
  return {
    name: 'task_create',
    description:
      '在当前会话的持久化任务图中创建任务。适合复杂、多步骤或跨回合工作；任务会写入磁盘并支持依赖关系',
    parameters: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          minLength: 1,
          description: '祈使句单行标题，例如“修复登录报错”'
        },
        description: {
          type: 'string',
          minLength: 1,
          description: '任务细节，说明要完成什么以及验收标准'
        },
        activeForm: {
          type: 'string',
          minLength: 1,
          description: '任务进行中时的文案，例如“正在修复登录报错”'
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description: '可选元信息，用于记录工具状态、验证标记等'
        }
      },
      required: ['subject', 'description'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    allowInPlanMode: true,
    contextCost: 'low',
    resultShape: 'state',
    jitHint: '任务图只返回轻量状态',
    isEnabled: () => controller.getTaskMode() === 'task',
    execute: async (input: Record<string, unknown>) => {
      const subject = pickTrimmedString(input, 'subject')
      const description = pickTrimmedString(input, 'description')
      const activeForm = pickTrimmedString(input, 'activeForm')
      const metadata = parseMetadata(input.metadata)

      if (!subject) return 'Error: `subject` must be a non-empty string.'
      if (!description) return 'Error: `description` must be a non-empty string.'
      if (input.metadata !== undefined && !metadata) return 'Error: `metadata` must be an object.'

      const task = await createTask(getTaskOptions(controller), {
        subject,
        description,
        activeForm,
        metadata
      })

      return [
        `## Task ${formatTaskRef(task.id)} created`,
        '',
        `- **Subject**: ${formatMarkdownInline(task.subject)}`
      ].join('\n')
    }
  }
}

function createTaskUpdateTool(controller: TaskToolController): ToolDefinition {
  return {
    name: 'task_update',
    description:
      '更新持久化任务图中的任务。可修改字段、切换状态、添加依赖，或将 status 设为 deleted 删除任务。更新前应先用 task_get 读取最新状态',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, description: '要更新的任务 id' },
        subject: { type: 'string', minLength: 1, description: '新的任务标题' },
        description: { type: 'string', minLength: 1, description: '新的任务描述' },
        activeForm: { type: 'string', description: '新的进行中文案；传空字符串可清除' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'deleted'],
          description: '新的任务状态；deleted 表示删除任务并清理依赖引用'
        },
        addBlocks: {
          type: 'array',
          items: { type: 'string' },
          description: '此任务会阻塞的下游任务 id 列表'
        },
        addBlockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: '会阻塞此任务的上游任务 id 列表'
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description: '元信息增量合并；字段值为 null 表示删除该 key'
        }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    allowInPlanMode: true,
    contextCost: 'low',
    resultShape: 'state',
    jitHint: '更新任务状态，不展开代码上下文',
    isEnabled: () => controller.getTaskMode() === 'task',
    execute: async (input: Record<string, unknown>) => {
      const taskId = pickTrimmedString(input, 'taskId')
      if (!taskId) return 'Error: `taskId` is required.'

      const options = getTaskOptions(controller)
      const existing = await getTask(options, taskId)
      if (!existing) return `## Task ${formatTaskRef(taskId)}\n\n未找到。`

      const rawStatus = pickTrimmedString(input, 'status')
      if (rawStatus !== undefined && !UPDATE_STATUSES.has(rawStatus)) {
        return `Error: invalid status '${rawStatus}'.`
      }

      const status = rawStatus as UpdateStatus | undefined
      if (status === 'deleted') {
        const deleted = await deleteTask(options, taskId)
        return deleted
          ? `## Task ${formatTaskRef(taskId)} deleted`
          : `## Task ${formatTaskRef(taskId)}\n\n未找到。`
      }

      const updates: Partial<Omit<Task, 'id'>> = {}
      const changed: string[] = []
      const fieldError = collectFieldUpdates(input, existing, updates, changed, status)
      if (fieldError) return fieldError

      if (Object.keys(updates).length > 0) {
        await updateTask(options, taskId, updates)
      }

      const dependencyWarnings = await applyDependencyUpdates(options, taskId, input, changed)
      if (changed.length === 0 && dependencyWarnings.length === 0) {
        return `## Task ${formatTaskRef(taskId)} unchanged`
      }

      return [
        changed.length > 0
          ? `## Task ${formatTaskRef(taskId)} updated\n\n- **Changed**: ${changed.join(', ')}`
          : `## Task ${formatTaskRef(taskId)} unchanged`,
        ...dependencyWarnings
      ].join('\n')
    }
  }
}

function createTaskGetTool(controller: TaskToolController): ToolDefinition {
  return {
    name: 'task_get',
    description: '按 id 读取单个任务的完整详情。更新任务前先调用它，避免基于过期状态修改',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, description: '任务 id' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    allowInPlanMode: true,
    contextCost: 'low',
    resultShape: 'state',
    jitHint: '按需读取单个任务详情',
    isEnabled: () => controller.getTaskMode() === 'task',
    execute: async (input: Record<string, unknown>) => {
      const taskId = pickTrimmedString(input, 'taskId')
      if (!taskId) return 'Error: `taskId` is required.'

      const options = getTaskOptions(controller)
      const [task, tasks] = await Promise.all([getTask(options, taskId), listTasks(options)])
      return task ? formatTaskDetail(task, tasks) : `## Task ${formatTaskRef(taskId)}\n\n未找到。`
    }
  }
}

function createTaskListTool(controller: TaskToolController): ToolDefinition {
  return {
    name: 'task_list',
    description:
      '列出当前会话任务图。开始工作前用它找 ready 的任务；完成任务后再用它确认哪些任务被解锁',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    allowInPlanMode: true,
    contextCost: 'low',
    resultShape: 'state',
    jitHint: '开始前和完成后查看轻量任务列表',
    isEnabled: () => controller.getTaskMode() === 'task',
    execute: async () => {
      return formatTaskList(await listTasks(getTaskOptions(controller)))
    }
  }
}

function getTaskOptions(controller: TaskToolController): TaskGraphOptions {
  return {
    cwd: controller.getCwd(),
    sessionId: controller.getSessionId()
  }
}

function formatTaskRef(id: string): string {
  return `#${id}`
}

function collectFieldUpdates(
  input: Record<string, unknown>,
  existing: Task,
  updates: Partial<Omit<Task, 'id'>>,
  changed: string[],
  status: TaskStatus | undefined
): string | null {
  const subject = pickTrimmedString(input, 'subject')
  if ('subject' in input && !subject) return 'Error: `subject` must be a non-empty string.'
  if (subject !== undefined && subject !== existing.subject) {
    updates.subject = subject
    changed.push('subject')
  }

  const description = pickTrimmedString(input, 'description')
  if ('description' in input && !description) return 'Error: `description` must be a non-empty string.'
  if (description !== undefined && description !== existing.description) {
    updates.description = description
    changed.push('description')
  }

  if ('activeForm' in input) {
    const activeForm = pickTrimmedString(input, 'activeForm')
    if (activeForm !== existing.activeForm) {
      updates.activeForm = activeForm
      changed.push('activeForm')
    }
  }

  if (status !== undefined && status !== existing.status) {
    updates.status = status
    changed.push('status')
  }

  if ('metadata' in input) {
    const metadata = parseMetadata(input.metadata)
    if (!metadata) return 'Error: `metadata` must be an object.'
    updates.metadata = mergeMetadata(existing.metadata, metadata)
    changed.push('metadata')
  }

  return null
}

async function applyDependencyUpdates(
  options: TaskGraphOptions,
  taskId: string,
  input: Record<string, unknown>,
  changed: string[]
): Promise<string[]> {
  const warnings: string[] = []
  // 模型只需要声明一侧依赖；blockTask 会同步维护 blocks 和 blockedBy 两边。
  const addBlocks = pickStringArray(input, 'addBlocks')
  if (addBlocks === null) warnings.push('Warning: `addBlocks` must be an array of strings.')
  if (addBlocks && addBlocks.length > 0) {
    let changedAny = false
    for (const downstreamId of addBlocks) {
      const result = await blockTask(options, taskId, downstreamId)
      if (result.changed) changedAny = true
      if (!result.ok) warnings.push(`Warning: could not add dependency #${taskId} blocks #${downstreamId}.`)
    }
    if (changedAny) changed.push('blocks')
  }

  const addBlockedBy = pickStringArray(input, 'addBlockedBy')
  if (addBlockedBy === null) warnings.push('Warning: `addBlockedBy` must be an array of strings.')
  if (addBlockedBy && addBlockedBy.length > 0) {
    let changedAny = false
    for (const upstreamId of addBlockedBy) {
      const result = await blockTask(options, upstreamId, taskId)
      if (result.changed) changedAny = true
      if (!result.ok) warnings.push(`Warning: could not add dependency #${upstreamId} blocks #${taskId}.`)
    }
    if (changedAny) changed.push('blockedBy')
  }

  return warnings
}

function mergeMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...(existing ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

function pickTrimmedString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value.trim() : undefined
}

function pickStringArray(input: Record<string, unknown>, key: string): string[] | null | undefined {
  if (!(key in input)) return undefined
  const value = input[key]
  if (!Array.isArray(value)) return null
  const result = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  return result.length === value.length ? Array.from(new Set(result)) : null
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return isRecord(value) ? { ...value } : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
