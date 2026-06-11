/**
 * 文件历史快照：按会话轮次记录写工具修改前状态，并支持 `/rewind` 回滚。
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getProjectStorageInfo } from '../context/project-paths'
import { isInsideDirectory } from '../tools/path-policy'

export const DEFAULT_FILE_HISTORY_MAX_SNAPSHOTS = 100
const MAX_EXACT_DIFF_BYTES = 1024 * 1024
const MAX_EXACT_DIFF_CELLS = 4_000_000

export interface FileHistoryBackup {
  backupFileName: string | null
  version: number
  backupTime: string
  size?: number
  mtimeMs?: number
  mode?: number
  contentHash?: string
}

export interface FileHistoryFileState {
  exists: boolean
  checkedAt: string
  size?: number
  mode?: number
  contentHash?: string
}

export interface FileHistorySnapshot {
  snapshotId: string
  turnId: string
  sessionId: string
  timestamp: string
  backupRoot?: string
  trackedFileBackups: Record<string, FileHistoryBackup>
  postEditFileStates: Record<string, FileHistoryFileState>
  editedFiles: string[]
}

export interface FileHistoryTranscriptSnapshot {
  snapshotId: string
  turnId: string
  sessionId: string
  timestamp: string
  backupRoot: string
  trackedFileBackups: Record<string, FileHistoryBackup>
  postEditFileStates: Record<string, FileHistoryFileState>
  editedFiles: string[]
}

export interface FileHistoryTranscriptRewind {
  snapshotId: string
  turnId: string
  sessionId: string
  timestamp: string
  steps: number
  removedSnapshotIds: string[]
}

export type FileHistoryTranscriptEvent =
  | { type: 'snapshot'; snapshot: FileHistoryTranscriptSnapshot }
  | { type: 'rewind'; rewind: FileHistoryTranscriptRewind }

export interface FileHistoryOptions {
  cwd: string
  sessionId: string
  maxSnapshots?: number
}

export interface FileHistoryState {
  cwd: string
  sessionId: string
  projectKey: string
  backupRoot: string
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  currentTurnId?: string
  maxSnapshots: number
}

export interface FileHistoryRewindResult {
  snapshot: FileHistorySnapshot
  changedFiles: FileHistoryChangedFile[]
  stats: FileHistoryDiffStats
  removedSnapshotIds: string[]
}

export interface FileHistoryChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted'
  insertions: number
  deletions: number
}

export interface FileHistoryDiffStats {
  filesChanged: FileHistoryChangedFile[]
  insertions: number
  deletions: number
}

export interface FileHistoryConflict {
  path: string
  reason: string
}

interface FileHistoryRestoreBackup {
  backup: FileHistoryBackup
  backupRoot: string
}

export class FileHistoryConflictError extends Error {
  readonly conflicts: FileHistoryConflict[]

  constructor(conflicts: FileHistoryConflict[]) {
    super(`File history rewind has ${conflicts.length} conflict(s)`)
    this.name = 'FileHistoryConflictError'
    this.conflicts = conflicts
  }
}

export function createFileHistoryState(options: FileHistoryOptions): FileHistoryState {
  const storage = getProjectStorageInfo(options.cwd)
  const backupRoot = join(resolveQCodeHome(), 'file-history', storage.projectKey, options.sessionId)
  mkdirSync(backupRoot, { recursive: true })
  return {
    cwd: storage.cwd,
    sessionId: options.sessionId,
    projectKey: storage.projectKey,
    backupRoot,
    snapshots: [],
    trackedFiles: new Set(),
    maxSnapshots: options.maxSnapshots ?? DEFAULT_FILE_HISTORY_MAX_SNAPSHOTS
  }
}

export function makeFileHistorySnapshot(state: FileHistoryState, turnId: string): FileHistorySnapshot {
  state.currentTurnId = turnId
  const previous = state.snapshots.at(-1)
  const trackedFileBackups: Record<string, FileHistoryBackup> = {}

  for (const trackingPath of state.trackedFiles) {
    const filePath = expandTrackingPath(state, trackingPath)
    const latestBackup = previous?.trackedFileBackups[trackingPath]
    const nextVersion = latestBackup ? latestBackup.version + 1 : 1
    const currentMeta = readFileMeta(filePath)

    if (!currentMeta) {
      trackedFileBackups[trackingPath] = {
        backupFileName: null,
        version: nextVersion,
        backupTime: new Date().toISOString()
      }
      continue
    }

    if (
      latestBackup &&
      latestBackup.backupFileName !== null &&
      !hasFileChangedSinceBackup(state, filePath, latestBackup, previous?.backupRoot ?? state.backupRoot)
    ) {
      trackedFileBackups[trackingPath] = latestBackup
      continue
    }

    trackedFileBackups[trackingPath] = createBackup(state, filePath, trackingPath, nextVersion)
  }

  const snapshot: FileHistorySnapshot = {
    snapshotId: randomUUID(),
    turnId,
    sessionId: state.sessionId,
    timestamp: new Date().toISOString(),
    backupRoot: state.backupRoot,
    trackedFileBackups,
    postEditFileStates: {},
    editedFiles: []
  }
  state.snapshots.push(snapshot)
  trimSnapshots(state)
  return snapshot
}

export function trackFileHistoryEdit(
  state: FileHistoryState,
  filePath: string,
  turnId: string = state.currentTurnId ?? randomUUID()
): FileHistorySnapshot {
  if (!state.currentTurnId || state.currentTurnId !== turnId || state.snapshots.length === 0) {
    makeFileHistorySnapshot(state, turnId)
  }

  const snapshot = state.snapshots.at(-1)!
  const resolved = resolveTrackedFilePath(state, filePath)
  if (isDirectoryPath(resolved)) return snapshot
  const trackingPath = shortenFilePath(state, resolved)
  markEdited(snapshot, trackingPath)
  if (snapshot.trackedFileBackups[trackingPath]) return snapshot

  const backup = existsSync(resolved)
    ? createBackup(state, resolved, trackingPath, nextVersionForTrackingPath(state, trackingPath))
    : {
        backupFileName: null,
        version: nextVersionForTrackingPath(state, trackingPath),
        backupTime: new Date().toISOString()
      }

  state.trackedFiles.add(trackingPath)
  snapshot.trackedFileBackups[trackingPath] = backup
  return snapshot
}

export function recordFileHistoryPostEdit(
  state: FileHistoryState,
  filePath: string,
  turnId: string = state.currentTurnId ?? randomUUID()
): FileHistorySnapshot {
  if (!state.currentTurnId || state.currentTurnId !== turnId || state.snapshots.length === 0) {
    makeFileHistorySnapshot(state, turnId)
  }

  const snapshot = state.snapshots.at(-1)!
  const resolved = resolveTrackedFilePath(state, filePath)
  if (isDirectoryPath(resolved)) return snapshot
  const trackingPath = shortenFilePath(state, resolved)
  markEdited(snapshot, trackingPath)
  state.trackedFiles.add(trackingPath)
  snapshot.postEditFileStates[trackingPath] = readFileState(resolved)
  return snapshot
}

export function rewindFileHistory(state: FileHistoryState, steps: number): FileHistoryRewindResult {
  if (!Number.isInteger(steps) || steps < 1) throw new Error('steps must be a positive integer')
  const snapshot = state.snapshots[state.snapshots.length - steps]
  if (!snapshot) throw new Error(`Cannot rewind ${steps} step(s): only ${state.snapshots.length} snapshot(s)`)

  const stats = getFileHistoryDiffStats(state, snapshot)
  const conflicts = collectRewindConflicts(state, snapshot)
  if (conflicts.length > 0) throw new FileHistoryConflictError(conflicts)

  for (const changed of stats.filesChanged) {
    const trackingPath = shortenFilePath(state, expandTrackingPath(state, changed.path))
    const restoreBackup = findRestoreBackupForPath(state, snapshot, trackingPath)
    const backup = restoreBackup?.backup
    const filePath = expandTrackingPath(state, trackingPath)
    if (!backup || backup.backupFileName === null) {
      rmSync(filePath, { force: true })
      continue
    }
    mkdirSync(dirname(filePath), { recursive: true })
    copyFileSync(getBackupPath(restoreBackup.backupRoot, backup), filePath)
  }

  const removedSnapshotIds = pruneSnapshotsFrom(state, snapshot)
  return { snapshot, changedFiles: stats.filesChanged, stats, removedSnapshotIds }
}

export function getFileHistoryDiffStats(
  state: FileHistoryState,
  snapshot: FileHistorySnapshot
): FileHistoryDiffStats {
  const filesChanged: FileHistoryChangedFile[] = []
  const paths = collectAffectedPaths(state, snapshot)
  for (const trackingPath of paths) {
    const currentPath = expandTrackingPath(state, trackingPath)
    const restoreBackup = findRestoreBackupForPath(state, snapshot, trackingPath)
    const changed = diffCurrentAgainstBackup(state, currentPath, restoreBackup)
    if (changed) filesChanged.push(changed)
  }
  return {
    filesChanged,
    insertions: filesChanged.reduce((sum, item) => sum + item.insertions, 0),
    deletions: filesChanged.reduce((sum, item) => sum + item.deletions, 0)
  }
}

export function snapshotToTranscriptEntry(
  state: FileHistoryState,
  snapshot: FileHistorySnapshot
): FileHistoryTranscriptSnapshot {
  return {
    snapshotId: snapshot.snapshotId,
    turnId: snapshot.turnId,
    sessionId: snapshot.sessionId,
    timestamp: snapshot.timestamp,
    backupRoot: snapshot.backupRoot ?? state.backupRoot,
    trackedFileBackups: snapshot.trackedFileBackups,
    postEditFileStates: snapshot.postEditFileStates,
    editedFiles: snapshot.editedFiles
  }
}

export function restoreFileHistorySnapshots(
  state: FileHistoryState,
  snapshots: readonly (FileHistorySnapshot | FileHistoryTranscriptSnapshot)[]
): void {
  const bySnapshotId = new Map<string, FileHistorySnapshot | FileHistoryTranscriptSnapshot>()
  for (const snapshot of snapshots) bySnapshotId.set(snapshot.snapshotId, snapshot)
  state.snapshots = [...bySnapshotId.values()].slice(-state.maxSnapshots).map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      turnId: snapshot.turnId,
      sessionId: snapshot.sessionId,
      timestamp: snapshot.timestamp,
      backupRoot: snapshot.backupRoot,
      trackedFileBackups: snapshot.trackedFileBackups,
      postEditFileStates: snapshot.postEditFileStates ?? {},
      editedFiles: snapshot.editedFiles ?? Object.keys(snapshot.postEditFileStates ?? snapshot.trackedFileBackups)
    }))
  state.trackedFiles = new Set(state.snapshots.flatMap((snapshot) => Object.keys(snapshot.trackedFileBackups)))
  state.currentTurnId = state.snapshots.at(-1)?.turnId
}

export function restoreFileHistoryTranscriptEvents(
  state: FileHistoryState,
  events: readonly FileHistoryTranscriptEvent[]
): void {
  const order: string[] = []
  const snapshots = new Map<string, FileHistorySnapshot | FileHistoryTranscriptSnapshot>()

  for (const event of events) {
    if (event.type === 'snapshot') {
      const snapshot = event.snapshot
      if (!snapshots.has(snapshot.snapshotId)) order.push(snapshot.snapshotId)
      snapshots.set(snapshot.snapshotId, snapshot)
      continue
    }

    const index = order.indexOf(event.rewind.snapshotId)
    if (index < 0) continue
    const removed = order.splice(index)
    for (const snapshotId of removed) snapshots.delete(snapshotId)
  }

  restoreFileHistorySnapshots(
    state,
    order
      .map((snapshotId) => snapshots.get(snapshotId))
      .filter((snapshot): snapshot is FileHistorySnapshot | FileHistoryTranscriptSnapshot => snapshot !== undefined)
  )
}

export function createFileHistoryTranscriptRewind(
  result: FileHistoryRewindResult,
  steps: number
): FileHistoryTranscriptRewind {
  return {
    snapshotId: result.snapshot.snapshotId,
    turnId: result.snapshot.turnId,
    sessionId: result.snapshot.sessionId,
    timestamp: new Date().toISOString(),
    steps,
    removedSnapshotIds: result.removedSnapshotIds
  }
}

function collectRewindConflicts(state: FileHistoryState, snapshot: FileHistorySnapshot): FileHistoryConflict[] {
  const conflicts: FileHistoryConflict[] = []
  const affectedPaths = collectAffectedPaths(state, snapshot)
  for (const trackingPath of affectedPaths) {
    const filePath = expandTrackingPath(state, trackingPath)
    const expectedState = findLatestKnownFileState(state, trackingPath)
    if (expectedState && !isCurrentFileState(filePath, expectedState)) {
      conflicts.push({ path: trackingPath, reason: '文件在最近快照后发生变化，拒绝静默覆盖' })
    }
  }
  return conflicts
}

function collectAffectedPaths(state: FileHistoryState, snapshot: FileHistorySnapshot): Set<string> {
  const startIndex = state.snapshots.indexOf(snapshot)
  const snapshots = startIndex >= 0 ? state.snapshots.slice(startIndex) : [snapshot]
  return new Set(snapshots.flatMap((item) => item.editedFiles))
}

function markEdited(snapshot: FileHistorySnapshot, trackingPath: string): void {
  if (!snapshot.editedFiles.includes(trackingPath)) snapshot.editedFiles.push(trackingPath)
}

function pruneSnapshotsFrom(state: FileHistoryState, snapshot: FileHistorySnapshot): string[] {
  const index = state.snapshots.indexOf(snapshot)
  if (index < 0) return []
  const removed = state.snapshots.splice(index)
  state.trackedFiles = new Set(state.snapshots.flatMap((item) => Object.keys(item.trackedFileBackups)))
  state.currentTurnId = state.snapshots.at(-1)?.turnId
  return removed.map((item) => item.snapshotId)
}

function findRestoreBackupForPath(
  state: FileHistoryState,
  snapshot: FileHistorySnapshot,
  trackingPath: string
): FileHistoryRestoreBackup | undefined {
  const startIndex = state.snapshots.indexOf(snapshot)
  const snapshots = startIndex >= 0 ? state.snapshots.slice(startIndex) : [snapshot]
  for (const item of snapshots) {
    const backup = item.trackedFileBackups[trackingPath]
    if (backup) return { backup, backupRoot: item.backupRoot ?? state.backupRoot }
  }
  return undefined
}

function diffCurrentAgainstBackup(
  state: FileHistoryState,
  currentPath: string,
  restoreBackup: FileHistoryRestoreBackup | undefined
): FileHistoryChangedFile | undefined {
  const displayPath = shortenFilePath(state, currentPath)
  const backup = restoreBackup?.backup
  const currentExists = existsSync(currentPath)
  const currentMeta = currentExists ? readFileMeta(currentPath) : undefined
  const backupPath = backup?.backupFileName && restoreBackup
    ? getBackupPath(restoreBackup.backupRoot, backup)
    : undefined
  const backupMeta = backupPath ? readFileMeta(backupPath) : undefined
  const backupExists = backup?.backupFileName !== null && backup?.backupFileName !== undefined

  if (!currentExists && !backupExists) return undefined
  if (currentExists && backupExists && areFilesEquivalent(currentPath, currentMeta, backup, backupPath, backupMeta)) {
    return undefined
  }

  if (shouldSkipExactDiff(currentMeta, backupMeta)) {
    return {
      path: displayPath,
      status: !backupExists ? 'added' : !currentExists ? 'deleted' : 'modified',
      insertions: 0,
      deletions: 0
    }
  }

  const currentText = currentExists ? readFileSafe(currentPath) : ''
  const backupText = backupPath ? readFileSafe(backupPath) : ''
  const { insertions, deletions } = countLineDiff(currentText, backupText)
  return {
    path: displayPath,
    status: !backupExists ? 'added' : !currentExists ? 'deleted' : 'modified',
    insertions,
    deletions
  }
}

function areFilesEquivalent(
  currentPath: string,
  currentMeta: ReturnType<typeof readFileMeta>,
  backup: FileHistoryBackup,
  backupPath: string | undefined,
  backupMeta: ReturnType<typeof readFileMeta>
): boolean {
  if (!currentMeta || !backupPath || !backupMeta) return false
  if (currentMeta.size !== backupMeta.size) return false
  if (backup.contentHash !== undefined) return hashFile(currentPath) === backup.contentHash
  return readFileSafe(currentPath) === readFileSafe(backupPath)
}

function shouldSkipExactDiff(
  currentMeta: ReturnType<typeof readFileMeta>,
  backupMeta: ReturnType<typeof readFileMeta>
): boolean {
  const currentSize = currentMeta?.size ?? 0
  const backupSize = backupMeta?.size ?? 0
  return currentSize > MAX_EXACT_DIFF_BYTES || backupSize > MAX_EXACT_DIFF_BYTES
}

function countLineDiff(fromText: string, toText: string): { insertions: number; deletions: number } {
  const fromLines = splitLines(fromText)
  const toLines = splitLines(toText)
  if (fromLines.length * toLines.length > MAX_EXACT_DIFF_CELLS) {
    return {
      deletions: fromLines.length,
      insertions: toLines.length
    }
  }
  const common = longestCommonSubsequenceLength(fromLines, toLines)
  return {
    deletions: fromLines.length - common,
    insertions: toLines.length - common
  }
}

function longestCommonSubsequenceLength(a: readonly string[], b: readonly string[]): number {
  const previous = Array(b.length + 1).fill(0) as number[]
  const current = Array(b.length + 1).fill(0) as number[]
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1]! + 1
        : Math.max(previous[j]!, current[j - 1]!)
    }
    previous.splice(0, previous.length, ...current)
    current.fill(0)
  }
  return previous[b.length] ?? 0
}

function createBackup(
  state: FileHistoryState,
  filePath: string,
  trackingPath: string,
  version: number
): FileHistoryBackup {
  const meta = readFileMeta(filePath)
  if (!meta) {
    return {
      backupFileName: null,
      version,
      backupTime: new Date().toISOString()
    }
  }
  mkdirSync(state.backupRoot, { recursive: true })
  const backupFileName = `${hashPath(trackingPath)}@v${version}`
  copyFileSync(filePath, join(state.backupRoot, backupFileName))
  return {
    backupFileName,
    version,
    backupTime: new Date().toISOString(),
    size: meta.size,
    mtimeMs: meta.mtimeMs,
    mode: meta.mode,
    contentHash: hashFile(filePath)
  }
}

function hasFileChangedSinceBackup(
  state: FileHistoryState,
  filePath: string,
  backup: FileHistoryBackup,
  backupRoot: string = state.backupRoot
): boolean {
  const currentMeta = readFileMeta(filePath)
  if (!currentMeta) return backup.backupFileName !== null
  if (backup.backupFileName === null) return true
  if (backup.size !== undefined && backup.size !== currentMeta.size) return true
  if (backup.mode !== undefined && backup.mode !== currentMeta.mode) return true
  if (backup.contentHash !== undefined) return hashFile(filePath) !== backup.contentHash
  return readFileSafe(filePath) !== readFileSafe(getBackupPath(backupRoot, backup))
}

function readFileMeta(filePath: string): { size: number; mtimeMs: number; mode: number } | undefined {
  try {
    const stat = statSync(filePath)
    if (stat.isDirectory()) return undefined
    return { size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode }
  } catch {
    return undefined
  }
}

function isDirectoryPath(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function nextVersionForTrackingPath(state: FileHistoryState, trackingPath: string): number {
  for (let index = state.snapshots.length - 1; index >= 0; index--) {
    const backup = state.snapshots[index]?.trackedFileBackups[trackingPath]
    if (backup) return backup.version + 1
  }
  return 1
}

function trimSnapshots(state: FileHistoryState): void {
  if (state.snapshots.length <= state.maxSnapshots) return
  state.snapshots = state.snapshots.slice(-state.maxSnapshots)
}

function shortenFilePath(state: FileHistoryState, filePath: string): string {
  const resolved = resolve(filePath)
  const relativePath = relative(state.cwd, resolved)
  if (relativePath === '') return '.'
  if (!relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return normalizePath(relativePath)
  }
  return normalizePath(resolved)
}

function expandTrackingPath(state: FileHistoryState, trackingPath: string): string {
  return isAbsolute(trackingPath) ? resolve(trackingPath) : resolve(state.cwd, trackingPath)
}

function resolveTrackedFilePath(state: FileHistoryState, filePath: string): string {
  const resolved = resolve(state.cwd, filePath)
  if (!isInsideDirectory(state.cwd, resolved)) {
    throw new Error(`文件历史拒绝追踪 cwd 外路径: ${filePath}`)
  }
  if (!existsSync(resolved)) return resolved

  const realTarget = realpathSync.native(resolved)
  const realRoot = existsSync(state.cwd) ? realpathSync.native(state.cwd) : state.cwd
  if (!isInsideDirectory(realRoot, realTarget)) {
    throw new Error(`文件历史拒绝追踪指向 cwd 外部的路径: ${filePath}`)
  }
  return resolved
}

function readFileState(filePath: string): FileHistoryFileState {
  const meta = readFileMeta(filePath)
  if (!meta) return { exists: false, checkedAt: new Date().toISOString() }
  return {
    exists: true,
    checkedAt: new Date().toISOString(),
    size: meta.size,
    mode: meta.mode,
    contentHash: hashFile(filePath)
  }
}

function isCurrentFileState(filePath: string, expected: FileHistoryFileState): boolean {
  const current = readFileState(filePath)
  if (current.exists !== expected.exists) return false
  if (!current.exists) return true
  return current.size === expected.size &&
    current.mode === expected.mode &&
    current.contentHash === expected.contentHash
}

function findLatestKnownFileState(state: FileHistoryState, trackingPath: string): FileHistoryFileState | undefined {
  for (let index = state.snapshots.length - 1; index >= 0; index--) {
    const snapshot = state.snapshots[index]
    const postState = snapshot?.postEditFileStates[trackingPath]
    if (postState) return postState
    const backup = snapshot?.trackedFileBackups[trackingPath]
    if (backup) return backupToFileState(backup, snapshot?.backupRoot ?? state.backupRoot)
  }
  return undefined
}

function backupToFileState(backup: FileHistoryBackup, backupRoot: string): FileHistoryFileState {
  if (backup.backupFileName === null) {
    return { exists: false, checkedAt: backup.backupTime }
  }
  return {
    exists: true,
    checkedAt: backup.backupTime,
    ...(backup.size !== undefined ? { size: backup.size } : {}),
    ...(backup.mode !== undefined ? { mode: backup.mode } : {}),
    ...(backup.contentHash !== undefined
      ? { contentHash: backup.contentHash }
      : { contentHash: hashFile(getBackupPath(backupRoot, backup)) })
  }
}

function getBackupPath(backupRoot: string, backup: FileHistoryBackup): string {
  if (backup.backupFileName === null) {
    throw new Error('Cannot resolve a deleted-file backup')
  }
  return join(backupRoot, backup.backupFileName)
}

function hashPath(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function resolveQCodeHome(): string {
  return resolve(process.env.Q_CODE_HOME?.trim() || join(resolve(process.env.USERPROFILE || process.env.HOME || '.'), '.q-code'))
}
