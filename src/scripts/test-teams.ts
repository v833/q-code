/**
 * Legacy 冒烟脚本：Agent Teams 建队、队友邮箱、SendMessage 与 worktree 协作。
 * 由 `pnpm test:teams` 调用。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAgentTeamsEnabled } from '../utils/agent-teams-enabled'
import {
  addTeamMember,
  cleanupTeamDirectory,
  formatAgentId,
  getTeamDir,
  getTeamFilePath,
  readTeamFileAsync,
  reconcileStaleActiveMembers,
  removeTeamMember,
  sanitizeName,
  setMemberActive,
  TEAM_LEAD_NAME,
  writeTeamFileAsync,
  type TeamFile,
  type TeamMember
} from '../agents/team-helpers'
import { clearActiveTeam, getActiveTeam, setActiveTeam } from '../agents/team-context'
import {
  drainUnreadMessages,
  formatMailboxAttachment,
  readMailbox,
  writeToMailbox
} from '../agents/teammate-mailbox'
import { formatTeamsSystemReminder } from '../agents/team-prompt'
import {
  createSendMessageTool,
  createTeamCreateTool,
  createTeamDeleteTool
} from '../tools/team-tools'
import { createAgentTool } from '../tools/agent-tools'
import { clearAgents } from '../agents/registry'
import { bootstrapAgents } from '../agents/bootstrap'
import { clearAllAsyncAgents, getAllAsyncAgents } from '../agents/async-agent-store'
import { clearPendingNotifications } from '../agents/notification-store'
import type { ToolDefinition } from '../tools/registry'

// Isolate the on-disk team root for this test.
const root = mkdtempSync(join(tmpdir(), 'q-code-teams-'))
const cwd = join(root, 'project')
const home = join(root, 'home')
mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })
process.env.Q_CODE_HOME = home
process.env.Q_CODE_TEAMS = '1'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败: ${message}`)
  console.log(`  ✓ ${message}`)
}

const noopTool: ToolDefinition = {
  name: 'noop',
  description: 'noop',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async () => 'ok'
}

try {
  console.log('\n[1] 特性开关')
  assert(isAgentTeamsEnabled(), 'Q_CODE_TEAMS=1 打开特性开关')
  const prevEnv = process.env.Q_CODE_TEAMS
  process.env.Q_CODE_TEAMS = '0'
  assert(!isAgentTeamsEnabled(), 'Q_CODE_TEAMS=0 保持特性开关关闭')
  process.env.Q_CODE_TEAMS = prevEnv

  console.log('\n[2] sanitizeName')
  assert(sanitizeName('My Team!') === 'my-team', 'sanitizeName 将非法字符压缩为单个连字符')
  assert(sanitizeName('FooBar') === 'foobar', 'sanitizeName 转为小写')
  assert(formatAgentId('Back End', 'My Team') === 'back-end@my-team', 'formatAgentId 会 sanitize')

  console.log('\n[3] teamHelpers 增删改查')
  const initial: TeamFile = {
    name: 'demo',
    createdAt: Date.now(),
    leadAgentId: formatAgentId(TEAM_LEAD_NAME, 'demo'),
    members: [
      {
        agentId: formatAgentId(TEAM_LEAD_NAME, 'demo'),
        name: TEAM_LEAD_NAME,
        joinedAt: Date.now(),
        isActive: true
      }
    ]
  }
  await writeTeamFileAsync('demo', initial)
  assert(existsSync(getTeamFilePath('demo')), 'writeTeamFileAsync 持久化 team.json')

  const member: TeamMember = {
    agentId: formatAgentId('backend', 'demo'),
    name: 'backend',
    joinedAt: Date.now(),
    isActive: true
  }
  await addTeamMember('demo', member)
  let file = await readTeamFileAsync('demo')
  assert(
    file?.members.some((m) => m.name === 'backend' && m.isActive),
    'addTeamMember 追加成员为 active'
  )

  // 幂等性：同名重复加入会就地覆盖。
  await addTeamMember('demo', { ...member, agentType: 'general-purpose' })
  file = await readTeamFileAsync('demo')
  const backendCount = file?.members.filter((m) => m.name === 'backend').length ?? 0
  assert(backendCount === 1, 'addTeamMember 同名重复加入保持幂等')

  await setMemberActive('demo', 'backend', false)
  file = await readTeamFileAsync('demo')
  assert(
    file?.members.find((m) => m.name === 'backend')?.isActive === false,
    'setMemberActive 将 isActive 翻为 false'
  )

  await removeTeamMember('demo', 'backend')
  file = await readTeamFileAsync('demo')
  assert(
    file?.members.every((m) => m.name !== 'backend'),
    'removeTeamMember 移除该成员条目'
  )

  // P0/D4: team.json 丢失时 addTeamMember 必须抛错而不是静默返回 null。
  // 不这样 AgentTool 启动路径无法区分 “成功注册” 与 “什么也没发生”。
  let threw = false
  try {
    await addTeamMember('does-not-exist', member)
  } catch (e) {
    threw = e instanceof Error && e.name === 'TeamFileMissingError'
  }
  assert(threw, 'team.json 丢失时 addTeamMember 抛 TeamFileMissingError')

  await cleanupTeamDirectory('demo')
  assert(!existsSync(getTeamDir('demo')), 'cleanupTeamDirectory 删除整个团队目录')

  console.log('\n[3b] schemaVersion + 原子写')
  await writeTeamFileAsync('versioned', {
    name: 'versioned',
    createdAt: Date.now(),
    leadAgentId: formatAgentId(TEAM_LEAD_NAME, 'versioned'),
    members: []
  })
  const versionedFile = await readTeamFileAsync('versioned')
  assert(versionedFile?.schemaVersion === 1, 'writeTeamFileAsync 自动写入 schemaVersion=1')

  // 原子写：成功后不会留下 .tmp-* 辅助文件（rename 已消费掉）。
  const versionedDir = getTeamDir('versioned')
  const versionedSiblings = readdirSync(versionedDir)
  assert(
    versionedSiblings.every((f) => !f.includes('.tmp-')),
    '原子写成功后不留下 .tmp- 残留'
  )
  await cleanupTeamDirectory('versioned')

  console.log('\n[3c] reconcileStaleActiveMembers（B3 启动恢复）')
  const ghostInitial: TeamFile = {
    name: 'ghost',
    createdAt: Date.now(),
    leadAgentId: formatAgentId(TEAM_LEAD_NAME, 'ghost'),
    members: [
      {
        agentId: formatAgentId(TEAM_LEAD_NAME, 'ghost'),
        name: TEAM_LEAD_NAME,
        joinedAt: Date.now(),
        isActive: true
      },
      {
        agentId: formatAgentId('zombie', 'ghost'),
        name: 'zombie',
        joinedAt: Date.now(),
        isActive: true
      },
      {
        agentId: formatAgentId('also-zombie', 'ghost'),
        name: 'also-zombie',
        joinedAt: Date.now(),
        isActive: true
      }
    ]
  }
  await writeTeamFileAsync('ghost', ghostInitial)
  const touched = await reconcileStaleActiveMembers()
  assert(touched.includes('ghost'), 'reconcileStaleActiveMembers 报告被处理过的团队')
  const reconciledFile = await readTeamFileAsync('ghost')
  assert(
    reconciledFile?.members.every((m) => (m.name === TEAM_LEAD_NAME ? m.isActive : !m.isActive)),
    'reconcile 保留 lead active 并将所有 teammate 翻为 idle'
  )
  // 幂等：再跑一次不会出现重复报告。
  const touchedAgain = await reconcileStaleActiveMembers()
  assert(!touchedAgain.includes('ghost'), 'reconcile 在清扫后具备幂等性')
  await cleanupTeamDirectory('ghost')

  console.log('\n[4] teammate 邮箱（并发写入安全）')
  await writeTeamFileAsync('demo2', { ...initial, name: 'demo2' })
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      writeToMailbox(
        'backend',
        { from: TEAM_LEAD_NAME, text: `msg-${i}`, timestamp: new Date().toISOString() },
        'demo2'
      )
    )
  )
  const all = await readMailbox('backend', 'demo2')
  assert(all.length === 8, '邮箱保留全部 8 条并发写入')

  const unread = await drainUnreadMessages('backend', 'demo2')
  assert(unread.length === 8, 'drainUnreadMessages 返回全部未读')
  const again = await drainUnreadMessages('backend', 'demo2')
  assert(again.length === 0, '二次抽取返回空（原子标读）')

  console.log('\n[5] formatMailboxAttachment')
  const formatted = formatMailboxAttachment([
    { from: 'lead', text: 'hello', timestamp: '2026-01-01T00:00:00Z', read: false },
    {
      from: 'frontend',
      text: 'pinged',
      timestamp: '2026-01-01T00:00:01Z',
      read: false,
      summary: 'ping'
    }
  ])
  assert(formatted.includes('<teammate-messages>'), '附件以 <teammate-messages> 开头')
  assert(formatted.includes('from="frontend"'), '附件输出 from 属性')
  assert(formatted.includes('summary="ping"'), '提供 summary 时附件输出其属性')

  console.log('\n[6] TeamCreate 工具')
  const teamCreate = createTeamCreateTool()
  const noActiveOk = await teamCreate.execute(
    { team_name: 'reviewers', description: 'parallel review' },
    { cwd }
  )
  assert(String(noActiveOk).includes('Team "reviewers" created'), '无活跃团队时 TeamCreate 成功')
  assert(getActiveTeam()?.teamName === 'reviewers', 'TeamCreate 设置活跃团队上下文')

  const dupActive = await teamCreate.execute({ team_name: 'others' }, { cwd })
  assert(String(dupActive).startsWith('Error:'), '已有活跃团队时 TeamCreate 拒绝创建第二个团队')

  console.log('\n[7] SendMessage tool')
  const sendMessage = createSendMessageTool()
  await addTeamMember('reviewers', {
    agentId: formatAgentId('security', 'reviewers'),
    name: 'security',
    joinedAt: Date.now(),
    isActive: true
  })
  await addTeamMember('reviewers', {
    agentId: formatAgentId('performance', 'reviewers'),
    name: 'performance',
    joinedAt: Date.now(),
    isActive: true
  })

  const leadSend = await sendMessage.execute({ to: 'security', message: 'check sql.ts' }, { cwd })
  assert(String(leadSend).includes('Message delivered'), 'lead → teammate 发送成功')
  const securityInbox = await readMailbox('security', 'reviewers')
  assert(securityInbox[0]?.from === TEAM_LEAD_NAME, '默认发件人记录为 team-lead')

  const broadcast = await sendMessage.execute({ to: '*', message: 'wrap up please' }, { cwd })
  assert(String(broadcast).includes('Broadcast delivered'), '广播到所有活跃 teammate 成功')

  const selfSend = await sendMessage.execute(
    { to: 'security', message: 'self talk' },
    { cwd, teammateIdentity: { agentName: 'security', teamName: 'reviewers' } }
  )
  assert(String(selfSend).includes('cannot SendMessage to yourself'), '拒绝自发自收')

  const teammateSend = await sendMessage.execute(
    { to: 'performance', message: 'sync up' },
    { cwd, teammateIdentity: { agentName: 'security', teamName: 'reviewers' } }
  )
  assert(String(teammateSend).includes('Message delivered'), 'teammate → teammate 发送成功')
  const perfInbox = await readMailbox('performance', 'reviewers')
  assert(
    perfInbox.some((m) => m.from === 'security'),
    '收件箱记录发件 teammate 身份'
  )

  const unknownRecipient = await sendMessage.execute(
    { to: 'ghost', message: 'where are you' },
    { cwd }
  )
  assert(String(unknownRecipient).includes('no teammate named "ghost"'), '未知收件人被拒绝')

  // P1/D1: 超过 8KB 上限的消息在进到邮箱之前就应被拒绝。
  const oversize = 'X'.repeat(12 * 1024)
  const oversizeResult = await sendMessage.execute({ to: 'security', message: oversize }, { cwd })
  assert(String(oversizeResult).includes('exceeding the'), '超限消息体被拒绝且返回字节数')
  // 且邮箱不应被污染。
  const securityAfter = await readMailbox('security', 'reviewers')
  assert(
    securityAfter.every((m) => !m.text.includes('XX')),
    '超限消息体不进入邮箱'
  )

  console.log('\n[8] TeamDelete 在有 active teammate 时拒绝清理')
  const teamDelete = createTeamDeleteTool()
  const refused = await teamDelete.execute({}, { cwd })
  assert(
    String(refused).includes('teammate(s) still active'),
    '仍有 active teammate 时 TeamDelete 拒绝执行'
  )

  // 全部翻为 idle 后，TeamDelete 应成功。
  await setMemberActive('reviewers', 'security', false)
  await setMemberActive('reviewers', 'performance', false)
  const okDelete = await teamDelete.execute({}, { cwd })
  assert(String(okDelete).includes('disbanded'), '所有 teammate idle 后 TeamDelete 成功')
  assert(getActiveTeam() === null, 'TeamDelete 清理进程内活跃团队上下文')
  assert(!existsSync(getTeamDir('reviewers')), 'TeamDelete 删除团队目录')

  console.log('\n[9] Agent 工具的 teammate 校验')
  // 重建一个新团队，为后续 AgentTool 路径提供目标。
  await teamCreate.execute({ team_name: 'val-team' }, { cwd })

  await bootstrapAgents(cwd)
  let capturedAsync: { teammateIdentity?: unknown } | undefined
  const agentTool = createAgentTool(
    {
      createModel: () => ({}),
      getDefaultModelName: () => 'default-model',
      getAvailableTools: () => [noopTool],
      getCwd: () => cwd,
      getSessionId: () => 'teams-test'
    },
    async () => ({
      agentType: 'general-purpose',
      finalText: 'sync',
      messages: [{ role: 'assistant' as const, content: 'sync' }],
      totalToolUseCount: 0,
      totalDurationMs: 1,
      totalTokens: 1,
      inputTokens: 1,
      outputTokens: 0,
      turnCount: 1,
      warnings: []
    }),
    async (params) => {
      capturedAsync = { teammateIdentity: params.teammateIdentity }
    }
  )

  const mismatch = await agentTool.execute(
    {
      prompt: 'review code',
      description: 'review',
      name: 'reviewer',
      team_name: 'wrong-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(String(mismatch).includes('does not match the active team'), 'team_name 不匹配被拒绝')

  const missingPair = await agentTool.execute(
    { prompt: 'p', description: 'd', name: 'only-name', run_in_background: true },
    { cwd }
  )
  assert(
    String(missingPair).includes("'name' and 'team_name' must be used together"),
    '只传 name 不传 team_name 被拒绝'
  )

  const reserved = await agentTool.execute(
    {
      prompt: 'p',
      description: 'd',
      name: TEAM_LEAD_NAME,
      team_name: 'val-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(String(reserved).includes('reserved'), 'team-lead 作为保留名被拒绝')

  const mustBg = await agentTool.execute(
    {
      prompt: 'p',
      description: 'd',
      name: 'reviewer',
      team_name: 'val-team',
      run_in_background: false
    },
    { cwd }
  )
  assert(String(mustBg).includes('must run in background'), '命名 teammate 必须后台运行')

  const nested = await agentTool.execute(
    {
      prompt: 'p',
      description: 'd',
      name: 'sub',
      team_name: 'val-team',
      run_in_background: true
    },
    {
      cwd,
      teammateIdentity: { agentName: 'parent', teamName: 'val-team' }
    }
  )
  assert(
    String(nested).includes('nested teammate spawn rejected'),
    'teammate 不能再派出嵌套的命名子 teammate'
  )

  // 快乐路径 — 应该异步启动并成功注册。
  const launched = await agentTool.execute(
    {
      prompt: 'do code review',
      description: 'reviewer',
      name: 'reviewer',
      team_name: 'val-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(String(launched).includes('<async_launched>'), '命名 teammate 走异步启动路径')
  assert(
    String(launched).includes('<teammate_name>reviewer</teammate_name>'),
    '启动结果带上 teammate 标识'
  )
  assert(capturedAsync?.teammateIdentity !== undefined, 'asyncRunner 参数中包含 teammateIdentity')

  const fileAfter = await readTeamFileAsync('val-team')
  assert(
    fileAfter?.members.some((m) => m.name === 'reviewer' && m.isActive),
    '启动之前 teammate 已被加入 team.json'
  )

  // P0/B2: 当 controller.createModel 同步抢错时，启动路径必须回滚刚插入的
  // teammate。否则该 teammate 会永久卡在 isActive=true，后续生命周期是走不到的，
  // 从而让 TeamDelete 永远拒绝执行。
  const explodingTool = createAgentTool(
    {
      createModel: () => {
        throw new Error('boom: model factory failed')
      },
      getDefaultModelName: () => 'default-model',
      getAvailableTools: () => [noopTool],
      getCwd: () => cwd,
      getSessionId: () => 'teams-test'
    },
    async () => ({
      agentType: 'general-purpose',
      finalText: '',
      messages: [],
      totalToolUseCount: 0,
      totalDurationMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
      warnings: []
    }),
    async () => undefined
  )
  const explodingResult = await explodingTool.execute(
    {
      prompt: 'p',
      description: 'will-fail',
      name: 'crashy',
      team_name: 'val-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(String(explodingResult).startsWith('Error:'), 'createModel 抢错被包装为工具级错误')
  const fileAfterRollback = await readTeamFileAsync('val-team')
  assert(
    fileAfterRollback?.members.every((m) => m.name !== 'crashy'),
    '失败启动将 teammate 从 team.json 中回滚（不会遗留鬼魂 active）'
  )

  // P0/D4: 在 lead 眼皮底下 team.json 丢失时，启动路径必须报出明确错误，
  // 而不是静默启动一个不在 lead 名册中的孤儿 teammate。
  await cleanupTeamDirectory('val-team') // 模拟手动 rm 掉 team.json
  const orphanResult = await agentTool.execute(
    {
      prompt: 'p',
      description: 'orphan',
      name: 'orphan',
      team_name: 'val-team',
      run_in_background: true
    },
    { cwd }
  )
  assert(
    String(orphanResult).includes('cannot register teammate') ||
      String(orphanResult).includes('does not match the active team'),
    'TeamCreate 后 team.json 丢失被报为注册错误'
  )
  // 重建团队以供下一个区段使用。
  clearActiveTeam()

  console.log('\n[10] team-prompt 三态 reminder')
  await Promise.resolve(teamDelete.execute({}, { cwd })).catch(() => undefined) // 尽力清理
  // 即使 TeamDelete 之后，旧运行遗留的 async-agent 条目仍在—手动清空
  clearAllAsyncAgents()

  process.env.Q_CODE_TEAMS = '0'
  assert(formatTeamsSystemReminder() === '', '特性开关关闭时 reminder 为空')
  process.env.Q_CODE_TEAMS = '1'
  clearActiveTeam()
  const idleReminder = formatTeamsSystemReminder()
  assert(idleReminder.includes('TeamCreate'), 'idle reminder 提及 TeamCreate')

  await teamCreate.execute({ team_name: 'roster' }, { cwd })
  await addTeamMember('roster', {
    agentId: formatAgentId('frontend', 'roster'),
    name: 'frontend',
    joinedAt: Date.now(),
    isActive: true
  })
  await addTeamMember('roster', {
    agentId: formatAgentId('backend', 'roster'),
    name: 'backend',
    joinedAt: Date.now(),
    isActive: false
  })
  const activeReminder = formatTeamsSystemReminder()
  assert(activeReminder.includes('frontend [active]'), 'active reminder 列出 active 成员')
  assert(activeReminder.includes('backend [idle]'), 'active reminder 标记 idle 成员')

  console.log('\n所有 Agent Teams 检查均通过。\n')
} finally {
  clearAllAsyncAgents()
  clearPendingNotifications()
  clearAgents()
  const active = getActiveTeam()
  if (active) {
    await cleanupTeamDirectory(active.teamName)
    clearActiveTeam()
  }
  delete process.env.Q_CODE_HOME
  delete process.env.Q_CODE_TEAMS
  rmSync(root, { recursive: true, force: true })
}
