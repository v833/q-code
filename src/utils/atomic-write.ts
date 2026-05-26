/**
 * 原子文件写入：先写唯一 tmp 路径、fsync，再 rename 覆盖目标文件。
 *
 * Windows 上对 EPERM/EACCES/EBUSY 的 rename 做有限次重试。
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'

const RENAME_MAX_ATTEMPTS = process.platform === 'win32' ? 40 : 1
const RENAME_RETRY_DELAY_MS = 10
const RENAME_MAX_RETRY_DELAY_MS = 250

/**
 * 原子写入 JSON：即使在写入过程中崩溃，也尽量保证文件可恢复。
 *
 * 朴素的 `fs.writeFile(path, JSON.stringify(value))` 对稍大一点的
 * 内容会拆成多次 `write(2)` 系统调用。如果进程在中途被 SIGKILL
 * （Ctrl+C、OOM、内核 panic、系统挂起）打断，文件就可能只写了一半；
 * 下一次 `JSON.parse` 会直接失败，连整个 mailbox / team roster 都读不出来。
 *
 * 这里采用的模式是：先写到 `<path>.tmp-<pid>-<ts>`，fsync，再 `rename`
 * 覆盖正式路径。POSIX `rename(2)` 在同一文件系统上是原子的，因此读取方
 * 要么看到旧版本，要么看到新版本，不会看到半截文件。临时文件名带唯一后缀，
 * 可以避免两个写入者互相踩到对方的 tmp 文件（同一路径的并发写本来会由别处的
 * 进程内锁避免，这里只是再加一层防御）。
 */
/**
 * 原子写入 JSON（pretty-print 两空格缩进）。
 *
 * @param filePath - 目标文件路径
 * @param value - 可 `JSON.stringify` 的值
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2))
}

/**
 * 原子写入 UTF-8 文本（tmp + fsync + rename）。
 *
 * @param filePath - 目标文件路径
 * @param content - 完整文件内容
 */
export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = createTempPath(filePath)
  const handle = await open(tmpPath, 'w')
  try {
    await handle.writeFile(content, 'utf-8')
    // 在 rename 前强制把 tmp inode 的数据刷盘。
    // 否则如果断电发生在 rename 之后，文件虽然存在，但内容可能是空的，
    // 就失去了“原子改名”这套方案的意义。
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(tmpPath, filePath)
  } catch (error) {
    // rename 失败时尽力清理 tmp 文件。
    await unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

/**
 * 同步版本，给必须保持同步的调用路径使用（例如在 process.on('exit')
 * 里触发的处理逻辑）。
 */
/**
 * `writeJsonAtomic` 的同步版本。
 *
 * @param filePath - 目标文件路径
 * @param value - 可 `JSON.stringify` 的值
 */
export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  writeTextAtomicSync(filePath, JSON.stringify(value, null, 2))
}

/**
 * `writeTextAtomic` 的同步版本，供 `process.on('exit')` 等同步路径使用。
 *
 * @param filePath - 目标文件路径
 * @param content - 完整文件内容
 */
export function writeTextAtomicSync(filePath: string, content: string): void {
  const tmpPath = createTempPath(filePath)
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 尽力清理。
    }
    throw error
  }
}

function createTempPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function renameWithRetry(tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmpPath, filePath)
      return
    } catch (error) {
      if (attempt >= RENAME_MAX_ATTEMPTS || !isTransientRenameError(error)) throw error
      await sleep(Math.min(RENAME_RETRY_DELAY_MS * attempt, RENAME_MAX_RETRY_DELAY_MS))
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
