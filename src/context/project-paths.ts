/**
 * 项目级持久化存储路径解析：按 cwd 哈希映射到 `.sessions/projects/<key>/`。
 */
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

const DEFAULT_STORAGE_DIR = '.sessions'

/** 会话/项目数据在存储根下的子目录名。 */
export const PROJECTS_DIR = 'projects'

/** 单个工作区对应的存储目录信息。 */
export interface ProjectStorageInfo {
  /** 解析后的当前工作目录绝对路径。 */
  cwd: string
  /** 存储根目录（如 `<cwd>/.sessions`）。 */
  rootDir: string
  /** 由目录名与路径哈希组成的项目键。 */
  projectKey: string
  /** 该项目专属数据目录。 */
  projectDir: string
}

/**
 * 根据 cwd 计算项目存储目录。
 * @param cwd 工作目录，默认 `process.cwd()`
 * @param storageDir 可选存储根覆盖（否则读 `Q_CODE_SESSION_DIR` 或 `.sessions`）
 */
export function getProjectStorageInfo(cwd: string = process.cwd(), storageDir?: string): ProjectStorageInfo {
  const resolvedCwd = resolve(cwd)
  const rootDir = resolveStorageRoot(resolvedCwd, storageDir)
  const projectKey = createProjectKey(resolvedCwd)

  return {
    cwd: resolvedCwd,
    rootDir,
    projectKey,
    projectDir: join(rootDir, PROJECTS_DIR, projectKey)
  }
}

/**
 * 解析会话数据存储根目录。
 * @param cwd 用于相对路径解析的基准目录
 * @param storageDir 显式目录或环境变量 `Q_CODE_SESSION_DIR`
 */
export function resolveStorageRoot(cwd: string, storageDir?: string): string {
  const configured = storageDir ?? process.env.Q_CODE_SESSION_DIR ?? DEFAULT_STORAGE_DIR
  return resolve(cwd, configured)
}

/**
 * 为 cwd 生成稳定且可读的项目键（目录名 + SHA256 前缀）。
 * @param cwd 工作目录绝对路径
 */
export function createProjectKey(cwd: string): string {
  const resolved = resolve(cwd)
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  const name = sanitizePathSegment(basename(resolved)) || 'project'
  return `${name}-${hash}`
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48)
}
