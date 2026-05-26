/**
 * 子 Agent 的 git worktree 隔离：在 `<gitRoot>/.q-code/worktrees/<slug>` 下
 * 创建独立分支与工作目录，并在任务结束且工作区干净时自动拆除。
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const WORKTREES_SUBDIR = path.join('.q-code', 'worktrees')

/** `createAgentWorktree` 成功后返回的 worktree 元数据。 */
export interface WorktreeInfo {
  worktreePath: string
  worktreeBranch: string
  /** 创建时 HEAD 的 commit，用于判断是否有新提交。 */
  headCommit: string
  gitRoot: string
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 自 `cwd` 向上查找包含 `.git` 的目录（最多 64 层）。
 * 非 git 仓库内返回 null。
 */
export async function findGitRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd)

  for (let depth = 0; depth < 64; depth++) {
    try {
      await fs.stat(path.join(current, '.git'))
      return current
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }

  return null
}

/**
 * 在仓库根下创建 Agent 专用 worktree 与分支（`worktree-<slug>`）。
 * 基于当前 HEAD，不拉取远程。
 */
export async function createAgentWorktree(slug: string, cwd: string): Promise<WorktreeInfo> {
  const gitRoot = await findGitRoot(cwd)
  if (!gitRoot) {
    throw new Error(`Cannot create worktree: ${cwd} is not inside a git repository.`)
  }

  const head = await git(['rev-parse', 'HEAD'], gitRoot)
  if (head.code !== 0) {
    throw new Error(`Failed to read HEAD: ${head.stderr.trim() || `exit ${head.code}`}`)
  }

  const worktreePath = worktreePathFor(gitRoot, slug)
  const worktreeBranch = worktreeBranchName(slug)
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })

  const add = await git(['worktree', 'add', '-B', worktreeBranch, worktreePath, 'HEAD'], gitRoot)
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr.trim() || `exit ${add.code}`}`)
  }

  return {
    worktreePath,
    worktreeBranch,
    headCommit: head.stdout.trim(),
    gitRoot
  }
}

/**
 * 判断 worktree 相对创建时是否有未提交改动或新 commit。
 * 无法读取状态时保守返回 true（视为 dirty）。
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string
): Promise<boolean> {
  const status = await git(['status', '--porcelain'], worktreePath)
  if (status.code !== 0) return true
  if (status.stdout.trim()) return true

  const commits = await git(['rev-list', '--count', `${headCommit}..HEAD`], worktreePath)
  if (commits.code !== 0) return true
  const count = Number.parseInt(commits.stdout.trim(), 10)
  return Number.isFinite(count) && count > 0
}

/**
 * 强制移除 worktree 并删除本地分支（`git branch -D`）。
 * 任一步失败时返回 `{ ok: false, error }`。
 */
export async function removeAgentWorktree(
  info: Pick<WorktreeInfo, 'worktreePath' | 'worktreeBranch' | 'gitRoot'>
): Promise<{ ok: boolean; error?: string }> {
  const errors: string[] = []

  const remove = await git(['worktree', 'remove', '--force', info.worktreePath], info.gitRoot)
  if (remove.code !== 0) {
    errors.push(`worktree remove: ${remove.stderr.trim() || `exit ${remove.code}`}`)
  }

  const branchDelete = await git(['branch', '-D', info.worktreeBranch], info.gitRoot)
  if (branchDelete.code !== 0) {
    errors.push(`branch -D: ${branchDelete.stderr.trim() || `exit ${branchDelete.code}`}`)
  }

  if (errors.length > 0) return { ok: false, error: errors.join('; ') }
  return { ok: true }
}

/**
 * 任务结束后：若 worktree 无改动则拆除并返回空对象；
 * 若仍 dirty 则保留路径供 lead 手动处理。
 */
export async function cleanupWorktreeIfClean(
  info: WorktreeInfo | undefined
): Promise<{ worktreePath?: string; worktreeBranch?: string }> {
  if (!info) return {}

  let dirty = true
  try {
    dirty = await hasWorktreeChanges(info.worktreePath, info.headCommit)
  } catch {
    dirty = true
  }

  if (dirty) {
    return {
      worktreePath: info.worktreePath,
      worktreeBranch: info.worktreeBranch
    }
  }

  await removeAgentWorktree(info)
  return {}
}

/** 生成分支名：`worktree-<flattened-slug>`。 */
export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

/** 生成 worktree 目录绝对路径。 */
export function worktreePathFor(gitRoot: string, slug: string): string {
  return path.join(gitRoot, WORKTREES_SUBDIR, flattenSlug(slug))
}

/** 包装 `git` 子进程；非零退出码不抛错，由调用方检查 `code`。 */
async function git(args: string[], cwd: string): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: number | string
      stdout?: string
      stderr?: string
    }
    const code = typeof err.code === 'number' ? err.code : 127
    return {
      code,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? (error instanceof Error ? error.message : String(error))
    }
  }
}

/** 将 slug 中非安全字符替换为 `+`，用于路径与分支名。 */
function flattenSlug(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]/g, '+')
}
