/**
 * 本地 Prompt 质量基线检查：按 12 个维度审计当前 system prompt。
 */
import { bootstrapAgents } from '../agents/bootstrap'
import { getAllAgents } from '../agents/registry'
import { formatAgentsSystemReminder } from '../agents/prompt-injection'
import { applyRuntimeConfig } from '../config/runtime-config'
import { loadAgentMdContext } from '../context/agent-md'
import {
  createSystemPromptBuilder,
  type PromptContext
} from '../context/prompt-builder'
import {
  analyzePromptQuality,
  formatPromptQualityMarkdown,
  sectionsFromInspection
} from '../context/prompt-quality'
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

type OutputFormat = 'json' | 'md'

async function main(): Promise<void> {
  applyRuntimeConfig()
  const format = readFormat(process.argv)
  const report = await buildPromptQualityReport()
  const output = format === 'json'
    ? JSON.stringify(report, null, 2)
    : formatPromptQualityMarkdown(report)

  console.log(output)
  if (!report.ok) process.exitCode = 1
}

async function buildPromptQualityReport(): Promise<ReturnType<typeof analyzePromptQuality>> {
  const cwd = process.cwd()
  await bootstrapAgents(cwd)
  const registry = await createVerificationToolRegistry(cwd)
  const activeTools = registry.getActiveTools()
  const builder = createSystemPromptBuilder()
  const ctx: PromptContext = {
    toolCount: activeTools.length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: 0,
    sessionId: 'prompt-quality-verify',
    agentMdContext: await loadAgentMdContext({ cwd }),
    agentsContext: formatAgentsSystemReminder(getAllAgents())
  }
  const sections = builder.inspect(ctx)

  return analyzePromptQuality(sectionsFromInspection(sections))
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
      getPlanFilePath: () => '<prompt-quality-verify-plan>',
      readPlan: async () => null,
      writePlan: async () => '<prompt-quality-verify-plan>',
      markPlanReady: () => {}
    })
  )
  registerBuiltinTools(
    ...createTaskTools({
      getSessionId: () => 'prompt-quality-verify',
      getCwd: () => cwd,
      getTaskMode: () => 'task'
    }),
    createTodoWriteTool({
      getSessionId: () => 'prompt-quality-verify',
      isEnabled: () => false
    })
  )
  registerBuiltinTools(createSkillTool({ getSessionId: () => 'prompt-quality-verify' }))
  registerBuiltinTools(
    createAgentTool({
      createModel: () => {
        throw new Error('prompt quality verification does not execute Agent tools')
      },
      getDefaultModelName: () => process.env.OPENAI_MODEL?.trim() || 'prompt-quality-verify',
      getAvailableTools: () => registry.getVisibleTools(),
      getSessionId: () => 'prompt-quality-verify',
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

function readFormat(argv: string[]): OutputFormat {
  const explicit = argv.find((arg) => arg.startsWith('--format='))
  if (!explicit) return 'json'
  const value = explicit.slice('--format='.length)
  if (value === 'json' || value === 'md') return value
  throw new Error(`unsupported --format value: ${value}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
