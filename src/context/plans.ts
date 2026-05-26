/**
 * Plan Mode 计划文件：按会话 ID 读写 `<projectDir>/plans/<session>.md`。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getProjectStorageInfo } from './project-paths'

/** 计划文件路径解析选项。 */
export interface PlanFileOptions {
  cwd?: string
  sessionId: string
  sessionDir?: string
}

/** 返回当前项目 plans 目录路径。 */
export function getPlansDirectory(options: PlanFileOptions): string {
  const storage = getProjectStorageInfo(options.cwd ?? process.cwd(), options.sessionDir)
  return join(storage.projectDir, 'plans')
}

/** 返回当前会话对应的计划文件绝对路径。 */
export function getPlanFilePath(options: PlanFileOptions): string {
  return join(getPlansDirectory(options), `${sanitizePlanFileName(options.sessionId)}.md`)
}

/** 创建 plans 目录（若不存在）并返回路径。 */
export async function ensurePlansDirectory(options: PlanFileOptions): Promise<string> {
  const plansDir = getPlansDirectory(options)
  await fs.mkdir(plansDir, { recursive: true })
  return plansDir
}

/**
 * 写入计划正文到会话计划文件。
 * @returns 写入后的文件绝对路径
 */
export async function writePlan(options: PlanFileOptions, content: string): Promise<string> {
  await ensurePlansDirectory(options)
  const filePath = getPlanFilePath(options)
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

/** 读取计划文件；不存在时返回 null。 */
export async function readPlan(options: PlanFileOptions): Promise<string | null> {
  try {
    return await fs.readFile(getPlanFilePath(options), 'utf-8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

/** 判断当前会话计划文件是否已存在。 */
export async function planExists(options: PlanFileOptions): Promise<boolean> {
  try {
    await fs.access(getPlanFilePath(options))
    return true
  } catch {
    return false
  }
}

function sanitizePlanFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'plan'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
