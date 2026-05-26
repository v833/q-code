/**
 * Legacy 冒烟脚本：同步子 Agent 注册、运行与工具白名单。
 * 由 `pnpm test:agents` 调用。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunChildAgentParams } from '../agents/run-agent'
import type { AgentRunResult } from '../agents/types'
import type { ToolDefinition } from '../tools/registry'

const root = mkdtempSync(join(tmpdir(), 'q-code-agents-'))
const cwd = join(root, 'project')
const home = join(root, 'home')
process.env.Q_CODE_HOME = home

mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })

function writeAgent(base: string, name: string, content: string): void {
  const dir = join(base, 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), content, 'utf-8')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败: ${message}`)
  console.log(`✓ ${message}`)
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'read',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async () => 'read'
}

const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'edit',
  parameters: { type: 'object', properties: {} },
  isReadOnly: false,
  isConcurrencySafe: false,
  execute: async () => 'edit'
}

const agentToolDefinition: ToolDefinition = {
  name: 'Agent',
  description: 'delegate',
  parameters: { type: 'object', properties: {} },
  isReadOnly: false,
  isConcurrencySafe: false,
  execute: async () => 'agent'
}

const enterPlanModeTool: ToolDefinition = {
  name: 'enter_plan_mode',
  description: 'enter plan mode',
  parameters: { type: 'object', properties: {} },
  isReadOnly: false,
  isConcurrencySafe: false,
  execute: async () => 'plan'
}

const mcpReadOnlyTool: ToolDefinition = {
  name: 'mcp__repo__read',
  description: 'mcp read',
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  isConcurrencySafe: true,
  shouldDefer: true,
  execute: async () => 'mcp'
}

try {
  writeAgent(
    home,
    'reviewer',
    [
      '---',
      'name: reviewer',
      'description: Global reviewer.',
      'tools: "read_file"',
      '---',
      '',
      'Global reviewer body.'
    ].join('\n')
  )

  writeAgent(
    join(cwd, '.q-code'),
    'reviewer',
    [
      '---',
      'name: reviewer',
      'description: Project reviewer.',
      'tools:',
      '  - read_file',
      '  - grep',
      'disallowedTools: "edit_file"',
      'model: "project-model"',
      'maxTurns: 7',
      'isolation: worktree',
      '---',
      '',
      'Project reviewer body.'
    ].join('\n')
  )

  writeAgent(
    join(cwd, '.q-code'),
    'broken',
    ['---', 'description: Missing name should warn.', '---', '', 'Broken body.'].join('\n')
  )

  const [
    { bootstrapAgents },
    registry,
    { formatAgentsSystemReminder },
    { resolveAgentTools },
    { createAgentTool }
  ] = await Promise.all([
    import('../agents/bootstrap'),
    import('../agents/registry'),
    import('../agents/prompt-injection'),
    import('../agents/resolve-agent-tools'),
    import('../tools/agent-tools')
  ])

  console.log('\n[1] 启动加载与优先级')
  const boot = await bootstrapAgents(cwd)
  assert(boot.customCount === 2, '计数有效的用户级与项目级自定义 Agent 文件')
  assert(boot.agentCount === 3, '加载两个内置 Agent 加上项目覆盖后的 reviewer')
  assert(
    boot.warnings.some((warning: string) => warning.includes('missing required')),
    '不合法的自定义 Agent 产生告警'
  )
  assert(registry.findAgent('reviewer')?.source === 'project', '项目级 Agent 覆盖用户级同名 Agent')
  assert(
    registry.findAgent('reviewer')?.getSystemPrompt().includes('Project reviewer body'),
    '使用项目级正文'
  )
  assert(registry.findAgent('reviewer')?.isolation === 'worktree', '解析项目级 Agent 的隔离设置')

  console.log('\n[2] 渐进式 discovery system-reminder')
  const reminder = formatAgentsSystemReminder(registry.getAllAgents())
  assert(reminder.includes('<system-reminder>'), '渲染出 <system-reminder> 包裹')
  assert(
    reminder.includes('reviewer [project, isolation=worktree]'),
    '列出项目级自定义 Agent 与隔离设置'
  )
  assert(!reminder.includes('Project reviewer body'), 'discovery 阶段不披露自定义 Agent 正文')

  console.log('\n[3] 工具过滤')
  const availableTools = [
    agentToolDefinition,
    enterPlanModeTool,
    readFileTool,
    editFileTool,
    mcpReadOnlyTool
  ]
  const explore = registry.findAgent('Explore')
  assert(explore, '内置的 Explore 存在')
  const exploreResolved = resolveAgentTools(explore, availableTools)
  assert(
    !exploreResolved.resolvedTools.some((tool: ToolDefinition) => tool.name === 'Agent'),
    '子 Agent 中剔除 Agent 工具，避免递归'
  )
  assert(
    !exploreResolved.resolvedTools.some((tool: ToolDefinition) => tool.name === 'enter_plan_mode'),
    '子 Agent 中剔除父 Plan Mode 控制工具'
  )
  assert(
    !exploreResolved.resolvedTools.some((tool: ToolDefinition) => tool.name === 'edit_file'),
    'Explore 剔除写入类工具'
  )
  assert(
    exploreResolved.resolvedTools.some((tool: ToolDefinition) => tool.name === 'mcp__repo__read'),
    'Explore 保留只读的 MCP 工具'
  )

  const explicitResolved = resolveAgentTools(
    { tools: ['read_file', 'edit_file', 'missing'], disallowedTools: ['edit_file'] },
    availableTools
  )
  assert(explicitResolved.resolvedTools.length === 1, '显式 allow-list 遵守 disallowedTools')
  assert(
    explicitResolved.resolvedTools[0].name === 'read_file',
    '显式 allow-list 保留被请求且被允许的工具'
  )
  assert(explicitResolved.invalidTools.includes('edit_file'), '被拒的请求工具被报为无效')
  assert(explicitResolved.invalidTools.includes('missing'), '未知的请求工具被报为无效')

  console.log('\n[4] Agent 工具分发')
  let captured: RunChildAgentParams | undefined
  const runner = async (params: RunChildAgentParams): Promise<AgentRunResult> => {
    captured = params
    return {
      agentType: params.agentDefinition.agentType,
      finalText: 'stub summary',
      messages: [{ role: 'assistant', content: 'stub summary' }],
      totalToolUseCount: 2,
      totalDurationMs: 12,
      totalTokens: 30,
      inputTokens: 20,
      outputTokens: 10,
      turnCount: 1,
      warnings: []
    }
  }
  const tool = createAgentTool(
    {
      createModel: (modelName?: string) => ({ modelName }),
      getDefaultModelName: () => 'default-model',
      getAvailableTools: () => availableTools,
      getCwd: () => cwd,
      getSessionId: () => 'test-session'
    },
    runner
  )
  const toolContext = { cwd }
  const output = await tool.execute(
    { prompt: 'Inspect something.', description: 'inspect' },
    toolContext
  )
  assert(typeof output === 'string', 'Agent 工具返回文本')
  assert(
    String(output).includes('<sub_agent_result>'),
    'Agent 工具以 <sub_agent_result> 包裹最终摘要'
  )
  assert(
    captured?.agentDefinition.agentType === 'general-purpose',
    '默认 fallback 到 general-purpose'
  )
  assert(
    (captured?.model as { modelName?: string }).modelName === 'default-model',
    '使用默认模型名 fallback'
  )

  const reviewerOutput = await tool.execute(
    {
      prompt: 'Review this.',
      description: 'review',
      subagent_type: 'reviewer'
    },
    toolContext
  )
  assert(String(reviewerOutput).includes("Sub-agent 'reviewer' completed"), '分发到自定义 Agent')
  assert(
    (captured?.model as { modelName?: string }).modelName === 'project-model',
    '使用 Agent 定义中的模型名 fallback'
  )

  const missingOutput = await tool.execute(
    {
      prompt: 'Do it.',
      description: 'missing',
      subagent_type: 'does-not-exist'
    },
    toolContext
  )
  assert(String(missingOutput).includes('not found'), '报告未知的子 Agent')

  console.log('\n所有 Agent 检查均通过。\n')
} finally {
  const { clearAgents } = await import('../agents/registry')
  clearAgents()
  rmSync(root, { recursive: true, force: true })
  delete process.env.Q_CODE_HOME
}
