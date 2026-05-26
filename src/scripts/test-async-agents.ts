/**
 * Legacy 冒烟脚本：后台 SubAgent 生命周期、JSONL 输出与进程清理。
 * 由 `pnpm test:agents` 链式调用。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearAllAsyncAgents, getAllAsyncAgents } from '../agents/async-agent-store'
import {
  clearPendingNotifications,
  drainPendingNotifications,
  enqueuePendingNotification,
  formatTaskNotification,
  pendingNotificationCount
} from '../agents/notification-store'
import type { RunAsyncAgentLifecycleParams } from '../agents/run-async-agent'
import { appendTaskOutput, ensureTaskOutputFile } from '../agents/task-output'
import { createAgentWorktree, hasWorktreeChanges, removeAgentWorktree } from '../agents/worktree'
import { bootstrapAgents } from '../agents/bootstrap'
import { clearAgents } from '../agents/registry'
import { createAgentTool } from '../tools/agent-tools'
import { readFileTool, writeFileTool } from '../tools/file-tools'
import { ToolRegistry, type ToolDefinition } from '../tools/registry'
import type { AgentRunResult } from '../agents/types'
import type { RunChildAgentParams } from '../agents/run-agent'

const root = mkdtempSync(join(tmpdir(), 'q-code-async-agents-'))
const cwd = join(root, 'project')
const home = join(root, 'home')
process.env.Q_CODE_HOME = home

mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败: ${message}`)
  console.log(`✓ ${message}`)
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
  console.log('\n[1] ToolRegistry 的 cwd 上下文透传')
  const registry = new ToolRegistry({ cwd })
  let seenCwd = ''
  registry.register({
    name: 'ctx_probe',
    description: '探针',
    parameters: { type: 'object', properties: {} },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async (_input, context) => {
      seenCwd = context.cwd
      return 'context-ok'
    }
  })
  const probeOutput = await registry.toAISDKFormat().ctx_probe.execute({})
  assert(probeOutput === 'context-ok', '注册表能通过 AI SDK 适配器执行工具')
  assert(seenCwd === cwd, '注册表将作用域 cwd 透传到工具')

  const fileRegistry = new ToolRegistry({ cwd })
  fileRegistry.register(writeFileTool, readFileTool)
  await fileRegistry.toAISDKFormat().write_file.execute({
    path: 'worktree-scope.txt',
    content: 'scoped'
  })
  assert(existsSync(join(cwd, 'worktree-scope.txt')), '文件工具从注册表 cwd 解析相对路径')

  console.log('\n[2] 异步 Agent 启动路径')
  const boot = await bootstrapAgents(cwd)
  assert(boot.agentCount >= 1, '加载内置 Agent 以供异步调度使用')

  let capturedAsync: RunAsyncAgentLifecycleParams | undefined
  const foregroundRunner = async (params: RunChildAgentParams): Promise<AgentRunResult> => ({
    agentType: params.agentDefinition.agentType,
    finalText: 'foreground',
    messages: [{ role: 'assistant', content: 'foreground' }],
    totalToolUseCount: 0,
    totalDurationMs: 1,
    totalTokens: 1,
    inputTokens: 1,
    outputTokens: 0,
    turnCount: 1,
    warnings: []
  })
  const asyncRunner = async (params: RunAsyncAgentLifecycleParams): Promise<void> => {
    capturedAsync = params
  }
  const agentTool = createAgentTool(
    {
      createModel: (modelName?: string) => ({ modelName }),
      getDefaultModelName: () => 'default-model',
      getAvailableTools: () => [noopTool],
      getCwd: () => cwd,
      getSessionId: () => 'async-session'
    },
    foregroundRunner,
    asyncRunner
  )
  const launch = await agentTool.execute(
    {
      prompt: '后台运行。',
      description: '异步',
      run_in_background: true
    },
    { cwd }
  )
  const asyncEntries = getAllAsyncAgents()
  assert(String(launch).includes('<async_launched>'), 'Agent 工具返回 <async_launched> 块')
  assert(asyncEntries.length === 1, '异步启动注册一个后台 Agent')
  assert(existsSync(asyncEntries[0].outputFile), '异步启动立刻创建输出文件')
  assert(
    capturedAsync?.entry.agentId === asyncEntries[0].agentId,
    '异步 runner 接收到已注册的 entry'
  )

  console.log('\n[3] 任务输出与通知')
  const outputFile = await ensureTaskOutputFile({
    cwd,
    sessionId: 'async-session',
    agentId: 'agent-output-test'
  })
  await appendTaskOutput(outputFile, {
    type: 'started',
    agentType: 'general-purpose',
    description: '输出测试',
    prompt: '你好'
  })
  const firstLine = readFileSync(outputFile, 'utf-8').trim().split('\n')[0]
  assert(JSON.parse(firstLine).type === 'started', '任务输出以 JSONL 写入事件')

  const notification = formatTaskNotification({
    agentId: 'agent-output-test',
    agentType: 'general-purpose',
    status: 'completed',
    outputFile,
    finalText: 'done'
  })
  enqueuePendingNotification({ mode: 'task-notification', text: notification })
  assert(pendingNotificationCount() === 1, '待注入通知队列增计')
  assert(drainPendingNotifications()[0].text.includes('<task-notification>'), '通知以 XML 文本出队')

  console.log('\n[4] git worktree 隔离辅助函数')
  if (gitAvailable()) {
    const repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    runGit(['init'], repo)
    runGit(['config', 'user.email', 'q-code@example.test'], repo)
    runGit(['config', 'user.name', 'q-code'], repo)
    writeFileSync(join(repo, 'README.md'), '# repo\n', 'utf-8')
    runGit(['add', 'README.md'], repo)
    runGit(['commit', '-m', 'init'], repo)

    const worktree = await createAgentWorktree('agent-test', repo)
    assert(existsSync(worktree.worktreePath), '创建专用的 git worktree')
    assert(
      (await hasWorktreeChanges(worktree.worktreePath, worktree.headCommit)) === false,
      '干净 worktree 报告无变更'
    )
    writeFileSync(join(worktree.worktreePath, 'agent.txt'), 'dirty\n', 'utf-8')
    assert(
      await hasWorktreeChanges(worktree.worktreePath, worktree.headCommit),
      '能检测出脏 worktree'
    )
    const removed = await removeAgentWorktree(worktree)
    assert(removed.ok, 'worktree 删除成功')
  } else {
    console.log('  未安装 git，跳过 worktree 辅助检查')
  }

  console.log('\n所有异步 Agent 检查均通过。\n')
} finally {
  clearAllAsyncAgents()
  clearPendingNotifications()
  clearAgents()
  delete process.env.Q_CODE_HOME
  rmSync(root, { recursive: true, force: true })
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function runGit(args: string[], gitCwd: string): void {
  execFileSync('git', args, {
    cwd: gitCwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}
