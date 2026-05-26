/**
 * Agent Teams 队友邮箱：按成员持久化 JSON 消息数组，支持并发安全的
 * 追加、未读排空与格式化为首轮 user 消息附件。
 *
 * 路径：`~/.q-code/teams/<team>/inboxes/<member>.json`
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { writeJsonAtomic } from '../utils/atomic-write'
import { getTeamDir, sanitizeName } from './team-helpers'

/**
 * inbox 中的一条消息，按原样持久化到 JSON 数组文件中。
 */
export interface TeammateMessage {
  /** 发送者的 `name`（不是 agentId）。lead 消息使用 TEAM_LEAD_NAME。 */
  from: string
  /** 纯文本正文。 */
  text: string
  /** 写入时生成的 ISO 时间戳。 */
  timestamp: string
  /** 在接收方消费前为 false。 */
  read: boolean
  /** 可选的 5-10 个词预览，会和完整消息一起展示。 */
  summary?: string
}

/**
 * 每个 inbox 一个进程内锁。实现方式是按 inbox path 维护 Promise
 * 链：每次 `withInboxLock` 先等待当前链尾，再把自己的工作接到链上。
 * 单进程 q-code 不需要 OS 级锁，但 Node 的微任务交错仍可能让两个
 * 并行写入者（例如两个异步队友同时给同一个收件人 SendMessage）在
 * read-modify-write 之间互相覆盖，因此这里仍需串行化。
 *
 * 语义上等价于源码里常见的 `proper-lockfile` 用法，但依赖更小——
 * q-code 本来就全部运行在一个 Node 进程内。
 */
const inboxLocks = new Map<string, Promise<unknown>>()

async function withInboxLock<T>(inboxPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = inboxLocks.get(inboxPath) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  inboxLocks.set(
    inboxPath,
    previous.then(() => next)
  )
  try {
    await previous
    return await fn()
  } finally {
    release()
    if (inboxLocks.get(inboxPath) === next) {
      inboxLocks.delete(inboxPath)
    }
  }
}

/** 某成员 inbox 文件的绝对路径。 */
export function getInboxPath(agentName: string, teamName: string): string {
  return path.join(getTeamDir(teamName), 'inboxes', `${sanitizeName(agentName)}.json`)
}

async function ensureInboxFile(agentName: string, teamName: string): Promise<string> {
  const inboxPath = getInboxPath(agentName, teamName)
  await fs.mkdir(path.dirname(inboxPath), { recursive: true })
  try {
    // `wx` 只会在文件不存在时写入——这样能保留重启后队友仍未读的消息。
    await fs.writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'EEXIST') throw error
  }
  return inboxPath
}

/**
 * 返回 inbox 中的全部消息（已读 + 未读）。当 inbox 不存在或 JSON
 * 损坏时返回 []，绝不抛错——因为收件箱损坏不该直接拖垮接收方循环。
 */
export async function readMailbox(agentName: string, teamName: string): Promise<TeammateMessage[]> {
  try {
    const content = await fs.readFile(getInboxPath(agentName, teamName), 'utf-8')
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? (parsed as TeammateMessage[]) : []
  } catch {
    return []
  }
}

/**
 * 向队友 inbox 追加一条消息。整个 read-modify-write 过程都在
 * 每个 inbox 的锁内完成，这样并发写入会按确定顺序追加，而不是
 * 互相覆盖。
 */
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName: string
): Promise<void> {
  const inboxPath = await ensureInboxFile(recipientName, teamName)
  await withInboxLock(inboxPath, async () => {
    const messages = await readMailbox(recipientName, teamName)
    messages.push({ ...message, read: false })
    // 原子写可以避免进程在写一半时被 SIGKILL 后留下半截 inbox JSON。
    // 读取方要么看到写前快照，要么看到写后快照，不会读到垃圾数据。
    await writeJsonAtomic(inboxPath, messages)
  })
}

/**
 * 在一个加锁操作里原子地读取所有未读消息，并把它们标记为已读。
 * 语义等价于“先读再标记”，但锁会横跨两个步骤，因此并发 SendMessage
 * 不会在步骤之间偷偷插入一条随后被我们误标为已读的消息。
 *
 * runChildAgent 在队友启动时会调用这个原语。
 */
export async function drainUnreadMessages(
  agentName: string,
  teamName: string
): Promise<TeammateMessage[]> {
  const inboxPath = getInboxPath(agentName, teamName)
  return withInboxLock(inboxPath, async () => {
    let messages: TeammateMessage[]
    try {
      const content = await fs.readFile(inboxPath, 'utf-8')
      const parsed = JSON.parse(content)
      messages = Array.isArray(parsed) ? (parsed as TeammateMessage[]) : []
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') return []
      throw error
    }
    const unread = messages.filter((m) => !m.read)
    if (unread.length === 0) return []
    let changed = false
    for (const m of messages) {
      if (!m.read) {
        m.read = true
        changed = true
      }
    }
    if (changed) {
      await writeJsonAtomic(inboxPath, messages)
    }
    return unread
  })
}

/**
 * 把未读消息格式化成一个 user 侧上下文块，追加到队友的首轮 prompt 前。
 */
export function formatMailboxAttachment(messages: TeammateMessage[]): string {
  if (messages.length === 0) return ''
  const blocks = messages.map((m) => {
    const attrs = [`from="${escapeAttr(m.from)}"`, `at="${escapeAttr(m.timestamp)}"`]
    if (m.summary) attrs.push(`summary="${escapeAttr(m.summary)}"`)
    return `<teammate-message ${attrs.join(' ')}>\n${m.text}\n</teammate-message>`
  })
  return [
    '<teammate-messages>',
    '以下消息由其他队友在你空闲期间发送。',
    '请将其视为与 user 指令同级的团队协调输入。',
    '',
    ...blocks,
    '</teammate-messages>'
  ].join('\n')
}

/** 转义 XML 属性值中的双引号。 */
function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;')
}
