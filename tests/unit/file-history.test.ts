import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FileHistoryConflictError,
  createFileHistoryTranscriptRewind,
  createFileHistoryState,
  getFileHistoryDiffStats,
  makeFileHistorySnapshot,
  recordFileHistoryPostEdit,
  restoreFileHistorySnapshots,
  restoreFileHistoryTranscriptEvents,
  rewindFileHistory,
  snapshotToTranscriptEntry,
  trackFileHistoryEdit
} from '../../src/file-history'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

describe('file history snapshots', () => {
  let home: TempHome

  beforeEach(() => {
    home = setupTempHome('file-history-')
  })

  afterEach(() => {
    home.dispose()
  })

  it('backs up the first version before a same-turn edit and rewinds it', () => {
    const file = join(home.cwd, 'note.txt')
    writeFileSync(file, 'before\n', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'note.txt', 'turn-1')
    writeFileSync(file, 'after\n', 'utf-8')
    recordFileHistoryPostEdit(state, 'note.txt', 'turn-1')

    const stats = getFileHistoryDiffStats(state, state.snapshots[0]!)
    expect(stats.filesChanged).toEqual([
      expect.objectContaining({ path: 'note.txt', status: 'modified' })
    ])

    rewindFileHistory(state, 1)

    expect(readFileSync(file, 'utf-8')).toBe('before\n')
  })

  it('backs up a file only once in a turn', () => {
    const file = join(home.cwd, 'note.txt')
    writeFileSync(file, 'before', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    makeFileHistorySnapshot(state, 'turn-1')
    const first = trackFileHistoryEdit(state, 'note.txt', 'turn-1')
    writeFileSync(file, 'middle', 'utf-8')
    const second = trackFileHistoryEdit(state, 'note.txt', 'turn-1')
    writeFileSync(file, 'after', 'utf-8')
    recordFileHistoryPostEdit(state, 'note.txt', 'turn-1')

    expect(first.trackedFileBackups['note.txt']).toBe(second.trackedFileBackups['note.txt'])
    rewindFileHistory(state, 1)
    expect(readFileSync(file, 'utf-8')).toBe('before')
  })

  it('deletes files created by a tracked write when rewinding', () => {
    const file = join(home.cwd, 'created.txt')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'created.txt', 'turn-1')
    writeFileSync(file, 'new file', 'utf-8')
    recordFileHistoryPostEdit(state, 'created.txt', 'turn-1')

    rewindFileHistory(state, 1)

    expect(existsSync(file)).toBe(false)
  })

  it('rewinds multiple turns to the first affected pre-edit state', () => {
    const a = join(home.cwd, 'a.txt')
    const b = join(home.cwd, 'nested', 'b.txt')
    mkdirSync(join(home.cwd, 'nested'), { recursive: true })
    writeFileSync(a, 'a0', 'utf-8')
    writeFileSync(b, 'b0', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'a.txt', 'turn-1')
    writeFileSync(a, 'a1', 'utf-8')
    recordFileHistoryPostEdit(state, 'a.txt', 'turn-1')

    makeFileHistorySnapshot(state, 'turn-2')
    trackFileHistoryEdit(state, 'nested/b.txt', 'turn-2')
    writeFileSync(b, 'b1', 'utf-8')
    recordFileHistoryPostEdit(state, 'nested/b.txt', 'turn-2')

    rewindFileHistory(state, 2)

    expect(readFileSync(a, 'utf-8')).toBe('a0')
    expect(readFileSync(b, 'utf-8')).toBe('b0')
  })

  it('does not rewind previously tracked files that were not edited in the selected turn range', () => {
    const a = join(home.cwd, 'a.txt')
    const b = join(home.cwd, 'b.txt')
    writeFileSync(a, 'a0', 'utf-8')
    writeFileSync(b, 'b0', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'a.txt', 'turn-1')
    writeFileSync(a, 'a1', 'utf-8')
    recordFileHistoryPostEdit(state, 'a.txt', 'turn-1')

    makeFileHistorySnapshot(state, 'turn-2')
    trackFileHistoryEdit(state, 'b.txt', 'turn-2')
    writeFileSync(b, 'b1', 'utf-8')
    recordFileHistoryPostEdit(state, 'b.txt', 'turn-2')

    rewindFileHistory(state, 1)

    expect(readFileSync(a, 'utf-8')).toBe('a1')
    expect(readFileSync(b, 'utf-8')).toBe('b0')
  })

  it('advances snapshot state after rewind so repeated rewinds target older turns', () => {
    const a = join(home.cwd, 'a.txt')
    const b = join(home.cwd, 'b.txt')
    writeFileSync(a, 'a0', 'utf-8')
    writeFileSync(b, 'b0', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'a.txt', 'turn-1')
    writeFileSync(a, 'a1', 'utf-8')
    recordFileHistoryPostEdit(state, 'a.txt', 'turn-1')

    makeFileHistorySnapshot(state, 'turn-2')
    trackFileHistoryEdit(state, 'b.txt', 'turn-2')
    writeFileSync(b, 'b1', 'utf-8')
    recordFileHistoryPostEdit(state, 'b.txt', 'turn-2')

    const first = rewindFileHistory(state, 1)
    expect(first.removedSnapshotIds).toEqual([expect.any(String)])
    expect(state.snapshots.map((snapshot) => snapshot.turnId)).toEqual(['turn-1'])
    expect(readFileSync(a, 'utf-8')).toBe('a1')
    expect(readFileSync(b, 'utf-8')).toBe('b0')

    rewindFileHistory(state, 1)

    expect(state.snapshots).toEqual([])
    expect(readFileSync(a, 'utf-8')).toBe('a0')
    expect(readFileSync(b, 'utf-8')).toBe('b0')
  })

  it('replays rewind transcript events when restoring state', () => {
    const a = join(home.cwd, 'a.txt')
    const b = join(home.cwd, 'b.txt')
    writeFileSync(a, 'a0', 'utf-8')
    writeFileSync(b, 'b0', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    const turn1 = makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'a.txt', 'turn-1')
    writeFileSync(a, 'a1', 'utf-8')
    recordFileHistoryPostEdit(state, 'a.txt', 'turn-1')
    const turn1Entry = snapshotToTranscriptEntry(state, turn1)

    const turn2 = makeFileHistorySnapshot(state, 'turn-2')
    trackFileHistoryEdit(state, 'b.txt', 'turn-2')
    writeFileSync(b, 'b1', 'utf-8')
    recordFileHistoryPostEdit(state, 'b.txt', 'turn-2')
    const turn2Entry = snapshotToTranscriptEntry(state, turn2)

    const rewind = rewindFileHistory(state, 1)
    const rewindEntry = createFileHistoryTranscriptRewind(rewind, 1)
    const restored = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    restoreFileHistoryTranscriptEvents(restored, [
      { type: 'snapshot', snapshot: turn1Entry },
      { type: 'snapshot', snapshot: turn2Entry },
      { type: 'rewind', rewind: rewindEntry }
    ])

    expect(restored.snapshots.map((snapshot) => snapshot.turnId)).toEqual(['turn-1'])
  })

  it('uses the snapshot backupRoot when restoring transcript metadata', () => {
    const file = join(home.cwd, 'note.txt')
    writeFileSync(file, 'before', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    const snapshot = makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'note.txt', 'turn-1')
    writeFileSync(file, 'after', 'utf-8')
    recordFileHistoryPostEdit(state, 'note.txt', 'turn-1')
    const entry = snapshotToTranscriptEntry(state, snapshot)

    const restored = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })
    restored.backupRoot = join(home.root, 'empty-backup-root')
    restoreFileHistorySnapshots(restored, [entry])
    rewindFileHistory(restored, 1)

    expect(readFileSync(file, 'utf-8')).toBe('before')
  })

  it('uses bounded stats for large files instead of exact line diff', () => {
    const file = join(home.cwd, 'large.txt')
    writeFileSync(file, 'a'.repeat(1024 * 1024 + 1), 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    const snapshot = makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'large.txt', 'turn-1')
    writeFileSync(file, 'b'.repeat(1024 * 1024 + 1), 'utf-8')
    recordFileHistoryPostEdit(state, 'large.txt', 'turn-1')

    const stats = getFileHistoryDiffStats(state, snapshot)

    expect(stats.filesChanged).toEqual([
      expect.objectContaining({ path: 'large.txt', status: 'modified', insertions: 0, deletions: 0 })
    ])
  })

  it('restores snapshots from transcript metadata', () => {
    const file = join(home.cwd, 'note.txt')
    writeFileSync(file, 'before', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    const snapshot = makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'note.txt', 'turn-1')
    writeFileSync(file, 'after', 'utf-8')
    recordFileHistoryPostEdit(state, 'note.txt', 'turn-1')
    const entry = snapshotToTranscriptEntry(state, snapshot)

    const restored = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })
    restoreFileHistorySnapshots(restored, [entry])
    rewindFileHistory(restored, 1)

    expect(readFileSync(file, 'utf-8')).toBe('before')
  })

  it('trims old snapshots while keeping the newest ones', () => {
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1', maxSnapshots: 2 })

    makeFileHistorySnapshot(state, 'turn-1')
    makeFileHistorySnapshot(state, 'turn-2')
    makeFileHistorySnapshot(state, 'turn-3')

    expect(state.snapshots.map((snapshot) => snapshot.turnId)).toEqual(['turn-2', 'turn-3'])
  })

  it('detects conflicts when a tracked file changed after the latest known write', () => {
    const file = join(home.cwd, 'note.txt')
    writeFileSync(file, 'before', 'utf-8')
    const state = createFileHistoryState({ cwd: home.cwd, sessionId: 's1' })

    makeFileHistorySnapshot(state, 'turn-1')
    trackFileHistoryEdit(state, 'note.txt', 'turn-1')
    writeFileSync(file, 'agent edit', 'utf-8')
    recordFileHistoryPostEdit(state, 'note.txt', 'turn-1')
    writeFileSync(file, 'outside edit', 'utf-8')

    expect(() => rewindFileHistory(state, 1)).toThrow(FileHistoryConflictError)
  })
})
