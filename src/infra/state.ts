/**
 * 项目级 Infra 同步状态的读写。
 *
 * 状态文件位于 `<cwd>/.q-code/infra-state.json`，通过原子 JSON 写入避免半截文件。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { writeJsonAtomic } from '../utils/atomic-write'
import type { InfraState } from './types'

/**
 * 返回项目级 `.q-code` 目录绝对路径。
 *
 * @param cwd - 项目工作目录
 */
export function getProjectInfraDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.q-code')
}

/**
 * 返回 `infra-state.json` 的绝对路径。
 *
 * @param cwd - 项目工作目录
 */
export function getProjectInfraStatePath(cwd: string): string {
  return path.join(getProjectInfraDir(cwd), 'infra-state.json')
}

/**
 * 读取本地 Infra 同步状态；文件不存在或解析失败时返回 `null`。
 *
 * @param cwd - 项目工作目录
 */
export async function readInfraState(cwd: string): Promise<InfraState | null> {
  try {
    const raw = await fs.readFile(getProjectInfraStatePath(cwd), 'utf-8')
    return JSON.parse(raw) as InfraState
  } catch {
    return null
  }
}

/**
 * 原子写入 Infra 同步状态。
 *
 * @param cwd - 项目工作目录
 * @param state - 要持久化的状态对象
 */
export async function writeInfraState(cwd: string, state: InfraState): Promise<void> {
  const statePath = getProjectInfraStatePath(cwd)
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  await writeJsonAtomic(statePath, state)
}
