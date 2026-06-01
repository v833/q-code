import { describe, expect, it } from 'vitest'
import {
  PromptBuilder,
  agentMdInstructions,
  agentsContext,
  coreRules,
  modeContext,
  projectMemory,
  runtimeEnvironment,
  sessionContext,
  skillDiscipline,
  skillsContext,
  taskContext,
  taskGuide,
  teamsContext,
  todoContext,
  todoGuide,
  toolDiscipline,
  toolGuide,
  toolRuntimeSummary,
  type PromptContext
} from '../../src/context/prompt-builder'
import { EXPLORE_AGENT } from '../../src/agents/built-in/explore'
import { formatOutputStylePrompt, type OutputStyleConfig } from '../../src/output-styles'

function baseCtx(extra: Partial<PromptContext> = {}): PromptContext {
  return {
    toolCount: 5,
    deferredToolSummary: '',
    sessionMessageCount: 0,
    sessionId: 'test-session',
    ...extra
  }
}

/**
 * PromptBuilder 是 System Prompt 的管道拼装器。
 * 核心不变式：
 *   - pipe 按注册顺序输出
 *   - 返回 null / 空字符串的 pipe 被跳过，不进最终 prompt
 *   - 各内置 pipe 只返回与自己相关字段的文本，字段缺失时返回 null
 */
describe('PromptBuilder System Prompt 管道', () => {
  it('section 按注册顺序输出', () => {
    const builder = new PromptBuilder()
      .pipe('first', () => 'AAA')
      .pipe('second', () => 'BBB')
      .pipe('third', () => 'CCC')

    const out = builder.build(baseCtx())
    const idxA = out.indexOf('AAA')
    const idxB = out.indexOf('BBB')
    const idxC = out.indexOf('CCC')
    expect(idxA).toBeGreaterThanOrEqual(0)
    expect(idxA).toBeLessThan(idxB)
    expect(idxB).toBeLessThan(idxC)
  })

  it('返回 null 或空字符串的 pipe 被跳过', () => {
    const builder = new PromptBuilder()
      .pipe('keep', () => 'KEEP')
      .pipe('skipped-null', () => null)
      .pipe('skipped-empty', () => '')
      .pipe('also-keep', () => 'ALSO')

    const out = builder.build(baseCtx())
    expect(out).toContain('KEEP')
    expect(out).toContain('ALSO')
    expect(out).not.toContain('skipped-null')
    expect(out).not.toContain('skipped-empty')
  })

  describe('内置 pipe', () => {
    it('coreRules 保持稳定，不随鸭子人格变化', () => {
      const defaultOut = coreRules()(baseCtx())
      expect(defaultOut).toContain('你是 q-code，一个有工具调用能力的 AI 助手')
      expect(defaultOut).toContain('可公开的进度说明')
      expect(defaultOut).not.toContain('降压鸭')
      expect(defaultOut).not.toContain('说话纪律')
    })

    it('modeContext 区分 plan 与 normal 模式', () => {
      const planOut = modeContext()(baseCtx({ agentMode: 'plan' }))
      const normalOut = modeContext()(baseCtx({ agentMode: 'normal' }))
      // 两个模式输出不同（至少一个需要输出提醒文本）
      const planText = String(planOut ?? '')
      const normalText = String(normalOut ?? '')
      expect(planText).not.toBe(normalText)
    })

    it('skillsContext 字段缺失时返回 null', () => {
      expect(skillsContext()(baseCtx())).toBeNull()
    })

    it('skillDiscipline 保持稳定，不包含当前 Skill 列表', () => {
      const out = skillDiscipline()(baseCtx({ skillsContext: '- reviewer: review code' }))

      expect(String(out)).toContain('Skill')
      expect(String(out)).toContain('当前模型可见 Skill')
      expect(String(out)).not.toContain('reviewer')
    })

    it('agentsContext / teamsContext / runtime / agentMd 透传各自字段', () => {
      const ctx = baseCtx({
        skillsContext: 'SK',
        agentsContext: 'AG',
        teamsContext: 'TM',
        runtimeContext: 'RT',
        agentMdContext: 'AMD',
        memoryContext: 'MEM'
      })
      expect(skillsContext()(ctx)).toBe('SK')
      expect(agentsContext()(ctx)).toBe('AG')
      expect(teamsContext()(ctx)).toBe('TM')
      expect(runtimeEnvironment()(ctx)).toContain('RT')
      expect(agentMdInstructions()(ctx)).toContain('AMD')
      expect(projectMemory()(ctx)).toContain('MEM')
    })

    it('taskGuide 与 todoGuide 按 taskMode 互斥', () => {
      const tg = taskGuide()(baseCtx({ taskMode: 'task' }))
      const tdg = todoGuide()(baseCtx({ taskMode: 'task' }))
      expect(tg).not.toBeNull()
      expect(tdg).toBeNull()

      const tg2 = taskGuide()(baseCtx({ taskMode: 'todo' }))
      const tdg2 = todoGuide()(baseCtx({ taskMode: 'todo' }))
      expect(tg2).toBeNull()
      expect(tdg2).not.toBeNull()
    })

    it('taskContext / todoContext 尊重各自字段', () => {
      // taskContext 仅在 taskMode === 'task' 时才输出，输出会带"当前持久化任务图："前缀
      const tcOut = taskContext()(baseCtx({ taskMode: 'task', taskContext: 'TC' }))
      expect(String(tcOut)).toContain('TC')
      expect(taskContext()(baseCtx({ taskMode: 'task' }))).toBeNull()
      expect(taskContext()(baseCtx({ taskMode: 'todo', taskContext: 'TC' }))).toBeNull()

      // todoContext 仅在 taskMode === 'todo' 时才输出
      const tdOut = todoContext()(baseCtx({ taskMode: 'todo', todoContext: 'TODO' }))
      expect(String(tdOut)).toContain('TODO')
      expect(todoContext()(baseCtx({ taskMode: 'task', todoContext: 'TODO' }))).toBeNull()
    })

    it('toolGuide 输出包含工具数量', () => {
      const out = toolGuide()(baseCtx({ toolCount: 42 }))
      expect(String(out)).toMatch(/42/)
    })

    it('toolDiscipline 保持稳定，不包含工具数量或委派状态', () => {
      const out = toolDiscipline()(baseCtx({
        toolCount: 42,
        canDelegateToAgents: true,
        jitToolSummary: '高成本: read_file'
      }))

      expect(String(out)).toContain('[JIT Context Discipline]')
      expect(String(out)).toContain('list_directory/glob → grep → read_file')
      expect(String(out)).not.toContain('42')
      expect(String(out)).not.toContain('Agent/Explore')
      expect(String(out)).not.toContain('高成本: read_file')
    })

    it('toolRuntimeSummary 承载工具数量、JIT 摘要和委派状态', () => {
      const withAgent = toolRuntimeSummary()(baseCtx({
        toolCount: 42,
        canDelegateToAgents: true,
        jitToolSummary: '高成本: read_file'
      }))
      const withoutAgent = toolRuntimeSummary()(baseCtx({ canDelegateToAgents: false }))

      expect(String(withAgent)).toContain('42')
      expect(String(withAgent)).toContain('Agent/Explore')
      expect(String(withAgent)).toContain('高成本: read_file')
      expect(String(withoutAgent)).not.toContain('Agent/Explore')
      expect(String(withoutAgent)).toContain('不要假设或调用不可见的委派能力')
    })

    it('Explore agent system prompt 明确禁止递归委派', () => {
      const prompt = EXPLORE_AGENT.getSystemPrompt()

      expect(prompt).toContain('不要调用 Agent')
      expect(prompt).toContain('只读工具')
    })

    it('sessionContext 在有历史消息时输出 sessionId', () => {
      const out = sessionContext()(baseCtx({ sessionId: 'abc-123', sessionMessageCount: 5 }))
      const nextOut = sessionContext()(baseCtx({ sessionId: 'abc-123', sessionMessageCount: 7 }))
      expect(String(out)).toContain('abc-123')
      expect(String(out)).not.toContain('5')
      expect(nextOut).toBe(out)
    })

    it('inspect exposes named sections for cache diagnostics', () => {
      const builder = new PromptBuilder()
        .pipe({ name: 'coreRules', stability: 'stable', category: 'core', cacheCritical: true }, coreRules())
        .pipe({ name: 'agentMdInstructions', stability: 'stable', category: 'project', cacheCritical: true }, agentMdInstructions())
        .pipe({ name: 'runtimeEnvironment', stability: 'dynamic', category: 'runtime' }, runtimeEnvironment())

      const sections = builder.inspect(baseCtx({
        agentMdContext: 'stable project rules',
        runtimeContext: 'dynamic runtime'
      }))

      expect(sections.map((section) => section.name)).toEqual([
        'coreRules',
        'agentMdInstructions',
        'runtimeEnvironment'
      ])
      expect(sections.find((section) => section.name === 'coreRules')).toMatchObject({
        stability: 'stable',
        category: 'core',
        cacheCritical: true
      })
      expect(sections.find((section) => section.name === 'agentMdInstructions')?.chars)
        .toBeGreaterThan(0)
    })

    it('recommended cache order keeps project instructions before runtime context', () => {
      const builder = new PromptBuilder()
        .pipe({ name: 'coreRules', stability: 'stable', category: 'core' }, coreRules())
        .pipe({ name: 'agentMdInstructions', stability: 'stable', category: 'project' }, agentMdInstructions())
        .pipe({ name: 'toolDiscipline', stability: 'stable', category: 'tools' }, toolDiscipline())
        .pipe({ name: 'toolRuntimeSummary', stability: 'dynamic', category: 'tools' }, toolRuntimeSummary())
        .pipe({ name: 'runtimeEnvironment', stability: 'dynamic', category: 'runtime' }, runtimeEnvironment())
        .pipe({ name: 'sessionContext', stability: 'session-stable', category: 'session' }, sessionContext())

      const out = builder.build(baseCtx({
        agentMdContext: 'PROJECT_RULES',
        runtimeContext: 'RUNTIME_CONTEXT',
        sessionMessageCount: 10
      }))

      expect(out.indexOf('PROJECT_RULES')).toBeLessThan(out.indexOf('RUNTIME_CONTEXT'))
    })

    it('stable pipes stay before dynamic pipes in the cache prefix', () => {
      const builder = new PromptBuilder()
        .pipe({ name: 'coreRules', stability: 'stable', category: 'core' }, coreRules())
        .pipe({ name: 'agentMdInstructions', stability: 'stable', category: 'project' }, agentMdInstructions())
        .pipe({ name: 'toolDiscipline', stability: 'stable', category: 'tools' }, toolDiscipline())
        .pipe({ name: 'skillDiscipline', stability: 'stable', category: 'skills' }, skillDiscipline())
        .pipe({ name: 'toolRuntimeSummary', stability: 'dynamic', category: 'tools' }, toolRuntimeSummary())
        .pipe({ name: 'runtimeEnvironment', stability: 'dynamic', category: 'runtime' }, runtimeEnvironment())

      const sections = builder.inspect(baseCtx({
        agentMdContext: 'PROJECT_RULES',
        runtimeContext: 'RUNTIME_CONTEXT'
      }))
      const firstDynamicIndex = sections.findIndex((section) => section.stability === 'dynamic')
      const stableAfterDynamic = sections
        .slice(firstDynamicIndex + 1)
        .filter((section) => section.stability === 'stable')

      expect(firstDynamicIndex).toBeGreaterThan(0)
      expect(stableAfterDynamic).toEqual([])
    })

    it('output style is dynamic turn context and does not change stable system prompt', () => {
      const style: OutputStyleConfig = {
        name: 'Explanatory',
        description: 'Explain',
        prompt: 'Use Insight blocks.',
        keepCodingInstructions: true,
        source: 'built-in'
      }
      const builder = new PromptBuilder()
        .pipe({ name: 'coreRules', stability: 'stable', category: 'core' }, coreRules())
        .pipe({ name: 'toolDiscipline', stability: 'stable', category: 'tools' }, toolDiscipline())

      const systemA = builder.build(baseCtx())
      const systemB = builder.build(baseCtx())
      const dynamicStyle = formatOutputStylePrompt(style)

      expect(systemA).toBe(systemB)
      expect(systemA).not.toContain('Use Insight blocks')
      expect(dynamicStyle).toContain('Use Insight blocks')
    })

    it('memory context is dynamic turn context and stays out of the stable system prompt', () => {
      const builder = new PromptBuilder()
        .pipe({ name: 'coreRules', stability: 'stable', category: 'core' }, coreRules())
        .pipe({ name: 'toolDiscipline', stability: 'stable', category: 'tools' }, toolDiscipline())

      const systemA = builder.build(baseCtx({ memoryContext: 'MEMORY.md index A' }))
      const systemB = builder.build(baseCtx({ memoryContext: 'different selected memory body' }))
      const dynamicMemory = projectMemory()(baseCtx({ memoryContext: 'different selected memory body' }))

      expect(systemA).toBe(systemB)
      expect(systemA).not.toContain('MEMORY.md index A')
      expect(systemB).not.toContain('different selected memory body')
      expect(dynamicMemory).toContain('different selected memory body')
    })
  })
})
