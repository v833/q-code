/**
 * Agent Teams 的磁盘持久化：`~/.q-code/teams/<team>/team.json` 与成员 roster。
 *
 * 提供团队目录路径、名称规范化、成员增删改、`isActive` 簿记，以及
 * 进程重启后对陈旧 active 标记的 reconcile。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { writeJsonAtomic, writeJsonAtomicSync } from '../utils/atomic-write'
import { getQCodeHome } from './load-agents-dir'

/**
 * TeamFile 结构发生不兼容变更时递增。
 * readTeamFile() 当前会接受任意版本——未来如需 schema
 * 迁移，应基于该字段分支处理。
 */
export const TEAM_FILE_SCHEMA_VERSION = 1

/**
 * 磁盘上的团队目录结构：
 *   ~/.q-code/teams/<sanitized-team-name>/
 *   ├── team.json              ← TeamFile（本模块）
 *   ├── inboxes/               ← teammate-mailbox 在此写入
 *   │   └── <name>.json
 */

export interface TeamMember {
  /** 确定性 id：`<name>@<teamName>`（例如 "backend@my-team"）。 */
  agentId: string
  /** SendMessage 使用的易读成员名，对应参数里的 `to`。 */
  name: string
  /** 该队友绑定的 agent 定义类型（例如 "general-purpose"）。 */
  agentType?: string
  /** 可选的模型覆盖。 */
  model?: string
  /** 成员加入团队时的 epoch 毫秒时间戳。 */
  joinedAt: number
  /**
   * 队友循环结束后变为 false（completed/failed/killed）。
   * lead 只要会话存活就始终视为 active。TeamDelete 会用它
   * 拒绝在仍有真实工作进行时清理团队。
   */
  isActive: boolean
  /** 该队友 `.output` JSONL transcript 的绝对路径。 */
  outputFile?: string
  /** 队友正在使用的 worktree 路径（当 isolation=worktree 时）。 */
  worktreePath?: string
  /** 与 `worktreePath` 配对的分支名。 */
  worktreeBranch?: string
  /** 拥有该 worktree 的仓库根目录（清理时传给 `git -C`）。 */
  gitRoot?: string
}

export interface TeamFile {
  /** 磁盘 JSON 的 schema 版本。写入时总会带上；旧文件可能缺失。 */
  schemaVersion?: number
  name: string
  description?: string
  /** TeamCreate 运行时的 epoch 毫秒时间戳。 */
  createdAt: number
  /** 团队 lead 的 agentId，同时也是 `members` 的第一项。 */
  leadAgentId: string
  members: TeamMember[]
}

/** 每个团队中约定的 lead 名称。 */
export const TEAM_LEAD_NAME = 'team-lead'

/** 所有团队状态文件的根目录：`~/.q-code/teams`。 */
export function getTeamsRoot(): string {
  return path.join(getQCodeHome(), 'teams')
}

/**
 * 生成可安全用于文件系统的 team/member 名称。
 *
 * 这里故意做得比较激进：返回值既会作为目录段，也会作为
 * inbox 文件名。若允许空格 / unicode / `..` 出现在这些位置，
 * 会带来可移植性和路径穿越风险。所有非字母数字字符会折叠为 `-`。
 */
export function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

/** 生成确定性成员 id：`<sanitized-name>@<sanitized-team>`。 */
export function formatAgentId(name: string, teamName: string): string {
  return `${sanitizeName(name)}@${sanitizeName(teamName)}`
}

/** 单个团队在磁盘上的目录（已 sanitize）。 */
export function getTeamDir(teamName: string): string {
  return path.join(getTeamsRoot(), sanitizeName(teamName))
}

export function getTeamFilePath(teamName: string): string {
  return path.join(getTeamDir(teamName), 'team.json')
}

// ─── 读写（同步 + 异步） ────────────────────────────────────

/** 同步读取 `team.json`；不存在或解析失败返回 null。 */
export function readTeamFile(teamName: string): TeamFile | null {
  try {
    const content = readFileSync(getTeamFilePath(teamName), 'utf-8')
    return JSON.parse(content) as TeamFile
  } catch {
    return null
  }
}

/** 异步读取 `team.json`；不存在或解析失败返回 null。 */
export async function readTeamFileAsync(teamName: string): Promise<TeamFile | null> {
  try {
    const content = await fs.readFile(getTeamFilePath(teamName), 'utf-8')
    return JSON.parse(content) as TeamFile
  } catch {
    return null
  }
}

/** 同步原子写入 `team.json`（自动打上 `schemaVersion`）。 */
export function writeTeamFile(teamName: string, file: TeamFile): void {
  mkdirSync(getTeamDir(teamName), { recursive: true })
  const stamped: TeamFile = { schemaVersion: TEAM_FILE_SCHEMA_VERSION, ...file }
  writeJsonAtomicSync(getTeamFilePath(teamName), stamped)
}

/** 异步原子写入 `team.json`。 */
export async function writeTeamFileAsync(teamName: string, file: TeamFile): Promise<void> {
  await fs.mkdir(getTeamDir(teamName), { recursive: true })
  const stamped: TeamFile = { schemaVersion: TEAM_FILE_SCHEMA_VERSION, ...file }
  await writeJsonAtomic(getTeamFilePath(teamName), stamped)
}

// ─── 成员列表变更 ──────────────────────────────────────────
//
// 单进程约束：这里只会由 lead 所在进程写入，并且写入会在同一个
// event loop turn 内串行发生（AgentTool 启动队友 → 注册成员；
// 没有并发路径会和这里竞争）。因此不需要额外的文件锁。
//
// 错误约定（post-D4）：这些 *Member helper 在底层 team.json
// 丢失时会抛出 `TeamFileMissingError`。以前静默返回 null 会掩盖
// “队友已启动但从未出现在 lead roster 中”的 bug。

/** `team.json` 在磁盘上缺失时由 `addTeamMember` 等抛出。 */
export class TeamFileMissingError extends Error {
  constructor(teamName: string) {
    super(`team.json for "${teamName}" is missing on disk`)
    this.name = 'TeamFileMissingError'
  }
}

/**
 * 向团队追加一个成员。若 `name` 冲突则保持幂等——
 * 用同名成员覆盖，而不是重复插入。
 *
 * 如果 team file 已丢失，会抛出 `TeamFileMissingError`；
 * 调用方（AgentTool 启动路径）会将其视为硬失败并回滚。
 */
export async function addTeamMember(teamName: string, member: TeamMember): Promise<TeamFile> {
  const file = await readTeamFileAsync(teamName)
  if (!file) throw new TeamFileMissingError(teamName)
  const filtered = file.members.filter((m) => m.name !== member.name)
  filtered.push(member)
  const next: TeamFile = { ...file, members: filtered }
  await writeTeamFileAsync(teamName, next)
  return next
}

/**
 * 更新指定成员的 `isActive` 标志。
 * 团队文件不存在时返回 null（与 `addTeamMember` 的硬失败不同）。
 */
export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean
): Promise<TeamFile | null> {
  const file = await readTeamFileAsync(teamName)
  if (!file) return null
  let changed = false
  const next: TeamFile = {
    ...file,
    members: file.members.map((m) => {
      if (m.name === memberName && m.isActive !== isActive) {
        changed = true
        return { ...m, isActive }
      }
      return m
    })
  }
  if (!changed) return file
  await writeTeamFileAsync(teamName, next)
  return next
}

/** 从 roster 移除成员；不存在则无操作并返回当前文件。 */
export async function removeTeamMember(
  teamName: string,
  memberName: string
): Promise<TeamFile | null> {
  const file = await readTeamFileAsync(teamName)
  if (!file) return null
  const filtered = file.members.filter((m) => m.name !== memberName)
  if (filtered.length === file.members.length) return file
  const next: TeamFile = { ...file, members: filtered }
  await writeTeamFileAsync(teamName, next)
  return next
}

/**
 * 启动时做一次尽力恢复：凡是之前的 q-code 进程拥有过的团队，
 * 如果它在把 `isActive` 翻回 false 之前就被杀掉，可能会留下
 * 队友仍标记为 `isActive=true`。
 * 新进程显然并没有在运行那些旧队友，所以启动时会扫描所有
 * team.json，把这些过期的 active 标记清掉。
 *
 * 返回本次被修正过的团队名列表（用于启动横幅输出）。
 */
export async function reconcileStaleActiveMembers(): Promise<string[]> {
  const touched: string[] = []
  const names = await listTeamNames()
  for (const name of names) {
    const file = await readTeamFileAsync(name)
    if (!file) continue
    let changed = false
    const members = file.members.map((m) => {
      if (m.name !== TEAM_LEAD_NAME && m.isActive) {
        changed = true
        return { ...m, isActive: false }
      }
      return m
    })
    if (changed) {
      await writeTeamFileAsync(name, { ...file, members })
      touched.push(name)
    }
  }
  return touched
}

// ─── 清理 ────────────────────────────────────────────────────────

/**
 * 尽力递归删除团队在磁盘上的状态目录。worktree 的清理由调用方负责——
 * 因为在本函数清空目录前，调用方还需要先读取成员列表。
 */
export async function cleanupTeamDirectory(teamName: string): Promise<void> {
  try {
    await fs.rm(getTeamDir(teamName), { recursive: true, force: true })
  } catch {
    // 尽力清理，失败不抛出。
  }
}

/** 列出 `teams` 根目录下所有团队目录名（已 sanitize 的文件夹名）。 */
export async function listTeamNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getTeamsRoot(), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}
