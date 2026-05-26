/**
 * 终端原始按键与 Ink `Key` 的映射：区分 Backspace 与 Delete 的 ANSI 序列。
 */
import type { Key } from 'ink'

type EditingKey = Pick<Key, 'backspace' | 'ctrl' | 'delete'>

const BACKSPACE_SEQUENCES = new Set(['\b', '\x1b\b', '\x7f', '\x1b\x7f'])

/**
 * 是否应执行向后删除（Backspace、Ctrl+H 或 Delete 键产生的退格序列）。
 */
export function shouldBackspace(value: string, key: EditingKey, rawInput?: string): boolean {
  if (key.backspace) return true
  if (key.ctrl && value === 'h') return true
  return key.delete && rawInput !== undefined && BACKSPACE_SEQUENCES.has(rawInput)
}

/** 是否应执行向前删除（Delete 键且非退格序列）。 */
export function shouldDeleteForward(key: EditingKey, rawInput?: string): boolean {
  if (!key.delete) return false
  return rawInput === undefined || !BACKSPACE_SEQUENCES.has(rawInput)
}
