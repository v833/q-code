/**
 * 本地 Prompt Cache 回归检查：验证稳定 system prompt 构造与前缀比例目标。
 */
import { applyRuntimeConfig } from '../config/runtime-config'
import { bootstrapAgents } from '../agents/bootstrap'
import { getAllAgents } from '../agents/registry'
import { formatAgentsSystemReminder } from '../agents/prompt-injection'
import { loadAgentMdContext } from '../context/agent-md'
import {
  createSystemPromptBuilder,
  type PromptContext
} from '../context/prompt-builder'
import {
  allTools,
  createAgentTool,
  createPlanTools,
  createSendMessageTool,
  createSkillTool,
  createTaskTools,
  createTeamCreateTool,
  createTeamDeleteTool,
  createTodoWriteTool,
  createToolSearchTool,
  loadAllCustomTools,
  ToolRegistry,
  type ToolDefinition
} from '../tools'
import {
  annotateCachePrefixSnapshot,
  createCachePrefixSnapshot,
  readCacheStablePrefixTarget
} from '../usage/cache'

async function main(): Promise<void> {
  applyRuntimeConfig()
  const target = readCacheStablePrefixTarget()
  const first = await buildSnapshot()
  const second = await buildSnapshot()
  const annotated = annotateCachePrefixSnapshot(second.snapshot, first.snapshot)
  const sameSystem = first.systemPrompt === second.systemPrompt
  const stablePrefixRatio = annotated.stablePrefixRatio ?? (sameSystem ? 1 : 0)
  const ok = sameSystem && stablePrefixRatio >= target

  console.log(
    JSON.stringify(
      {
        ok,
        target,
        sameSystem,
        stablePrefixRatio,
        systemChars: second.systemPrompt.length,
        systemHash: second.snapshot.systemHash,
        sections: annotated.systemSections?.map((section) => ({
          name: section.name,
          changed: section.changed === true,
          chars: section.chars,
          stability: section.stability,
          category: section.category
        }))
      },
      null,
      2
    )
  )

  if (!ok) process.exitCode = 1
}

async function buildSnapshot(): Promise<{
  systemPrompt: string
  snapshot: ReturnType<typeof createCachePrefixSnapshot>
}> {
  const cwd = process.cwd()
  await bootstrapAgents(cwd)
  const registry = await createVerificationToolRegistry(cwd)
  const activeTools = registry.getActiveTools()
  const builder = createSystemPromptBuilder()
  const ctx: PromptContext = {
    toolCount: activeTools.length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: 0,
    sessionId: 'prompt-cache-verify',
    agentMdContext: await loadAgentMdContext({ cwd }),
    agentsContext: formatAgentsSystemReminder(getAllAgents())
  }
  const sections = builder.inspect(ctx)
  const systemPrompt = sections
    .filter((section) => section.enabled)
    .map((section) => section.text)
    .join('\n\n')
  const snapshot = createCachePrefixSnapshot({
    systemPrompt,
    tools: activeTools,
    activeToolSchemaTokens: registry.countTokenEstimate().active,
    systemSections: sections
  })

  return { systemPrompt, snapshot }
}

async function createVerificationToolRegistry(cwd: string): Promise<ToolRegistry> {
  const registry = new ToolRegistry({ cwd, quiet: true })
  const customTools = await loadAllCustomTools(cwd)
  const customToolNames = new Set(customTools.tools.map((tool) => tool.name))
  const registerBuiltinTools = (...tools: ToolDefinition[]): void => {
    registry.register(...tools.filter((tool) => !customToolNames.has(tool.name)))
  }

  registerBuiltinTools(...allTools)
  registry.register(...customTools.tools)
  registerBuiltinTools(createToolSearchTool(registry))
  registerBuiltinTools(
    ...createPlanTools({
      getMode: () => 'normal',
      setMode: () => {},
      getPlanFilePath: () => '<prompt-cache-verify-plan>',
      readPlan: async () => null,
      writePlan: async () => '<prompt-cache-verify-plan>',
      markPlanReady: () => {}
    })
  )
  registerBuiltinTools(
    ...createTaskTools({
      getSessionId: () => 'prompt-cache-verify',
      getCwd: () => cwd,
      getTaskMode: () => 'task'
    }),
    createTodoWriteTool({
      getSessionId: () => 'prompt-cache-verify',
      isEnabled: () => false
    })
  )
  registerBuiltinTools(createSkillTool({ getSessionId: () => 'prompt-cache-verify' }))
  registerBuiltinTools(
    createAgentTool({
      createModel: () => {
        throw new Error('prompt cache verification does not execute Agent tools')
      },
      getDefaultModelName: () => process.env.OPENAI_MODEL?.trim() || 'prompt-cache-verify',
      getAvailableTools: () => registry.getVisibleTools(),
      getSessionId: () => 'prompt-cache-verify',
      getCwd: () => cwd
    })
  )
  registerBuiltinTools(
    createTeamCreateTool(),
    createTeamDeleteTool(),
    createSendMessageTool()
  )
  return registry
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
