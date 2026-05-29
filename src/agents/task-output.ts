/**
 * SubAgent 的 JSONL 任务转录：按事件追加到
 * `<projectDir>/async-agents/<session>/<agentId>.output`。
 *
 * 文件仅用于可观测性与 `/agents` 查看；写入失败不影响任务完成。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getProjectStorageInfo } from '../context/project-paths'

/** 单行 JSONL 记录中的 `type` 判别联合。 */
export type TaskOutputEvent =
  | { type: 'started'; agentType: string; description?: string; prompt: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolName: string; toolCallId?: string }
  | { type: 'tool_progress'; toolName: string; toolCallId?: string; text: string }
  | { type: 'tool_result'; toolName: string; toolCallId?: string; isError: boolean; preview: string }
  | {
      type: 'turn_usage'
      inputTokens: number
      outputTokens: number
      totalTokens: number
      turn: number
    }
  | {
      type: 'completed'
      finalText: string
      durationMs: number
      totalTokens: number
      toolUseCount: number
    }
  | { type: 'failed'; error: string; durationMs: number }

/** 计算任务输出文件的绝对路径（不创建文件）。 */
export function getTaskOutputPath(params: {
  cwd: string
  sessionId: string
  agentId: string
}): string {
  const storage = getProjectStorageInfo(params.cwd)
  return path.join(
    storage.projectDir,
    'async-agents',
    sanitizeSegment(params.sessionId),
    `${sanitizeSegment(params.agentId)}.output`
  )
}

/** 确保输出文件所在目录存在并 touch 空文件，返回路径。 */
export async function ensureTaskOutputFile(params: {
  cwd: string
  sessionId: string
  agentId: string
}): Promise<string> {
  const filePath = getTaskOutputPath(params)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const handle = await fs.open(filePath, 'a')
  await handle.close()
  return filePath
}

/**
 * 追加一条带 ISO 时间戳的 JSONL 事件。
 * 写入失败时静默忽略。
 */
export async function appendTaskOutput(filePath: string, event: TaskOutputEvent): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    ...event
  }

  try {
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`)
  } catch {
    // 输出文件仅供观测；不应拖垮任务完成路径。
  }
}

/** 将工具返回值序列化并截断，供 JSONL `tool_result.preview` 使用。 */
export function previewToolResult(value: unknown, max = 2000): string {
  const text = typeof value === 'string' ? value : stringify(value)
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-')
}
