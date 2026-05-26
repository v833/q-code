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
  skillsContext,
  taskContext,
  taskGuide,
  teamsContext,
  todoContext,
  todoGuide,
  toolGuide,
  type PromptContext
} from '../../src/context/prompt-builder'

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
    it('coreRules 输出非空', () => {
      const out = coreRules()(baseCtx())
      expect(out).toBeTruthy()
      expect(out).toContain('可公开的进度说明')
      expect(out).toContain('不要暴露隐藏推理链')
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

    it('sessionContext 在有历史消息时输出 sessionId', () => {
      // 0 条历史时不输出（避免新会话 prompt 噪音）
      expect(sessionContext()(baseCtx({ sessionId: 'abc-123' }))).toBeNull()

      const out = sessionContext()(baseCtx({ sessionId: 'abc-123', sessionMessageCount: 5 }))
      expect(String(out)).toContain('abc-123')
      expect(String(out)).toContain('5')
    })
  })
})
