import { describe, expect, it } from 'vitest'
import {
  analyzePromptQuality,
  formatPromptQualityMarkdown,
  getPromptQualityDimensions,
  sectionsFromInspection,
  type PromptQualitySection
} from '../../src/context/prompt-quality'
import {
  createSystemPromptBuilder,
  type PromptContext
} from '../../src/context/prompt-builder'

function section(name: string, text: string, enabled = true): PromptQualitySection {
  return { name, text, enabled }
}

function baseCtx(extra: Partial<PromptContext> = {}): PromptContext {
  return {
    toolCount: 8,
    deferredToolSummary: '',
    sessionMessageCount: 0,
    sessionId: 'quality-test',
    ...extra
  }
}

describe('Prompt quality baseline', () => {
  it('defines the 12 prompt quality dimensions', () => {
    const dimensions = getPromptQualityDimensions()

    expect(dimensions).toHaveLength(12)
    expect(dimensions.map((dimension) => dimension.id)).toEqual([
      'identity',
      'security-boundary',
      'tool-contract',
      'workflow-gates',
      'output-contract',
      'editing-contract',
      'memory-boundary',
      'communication-levels',
      'domain-knowledge',
      'few-shot-alignment',
      'failure-recovery',
      'quality-constraints'
    ])
  })

  it('reports pass, warn, and missing dimensions', () => {
    const report = analyzePromptQuality([
      section('coreRules', '你是 q-code，一个有工具调用能力的 AI 助手。'),
      section('toolDiscipline', '工具 grep read_file 失败 换一个思路')
    ])

    expect(report.summary.total).toBe(12)
    expect(report.summary.warn).toBeGreaterThan(0)
    expect(report.summary.missing).toBeGreaterThan(0)
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.id === 'identity')).toMatchObject({
      status: 'warn',
      evidence: expect.arrayContaining(['你是 q-code', 'AI 助手'])
    })
    expect(report.checks.find((check) => check.id === 'few-shot-alignment')).toMatchObject({
      status: 'missing'
    })
  })

  it('ignores disabled prompt sections', () => {
    const report = analyzePromptQuality([
      section('disabled', '你是 q-code AI 助手', false)
    ])

    expect(report.checks.find((check) => check.id === 'identity')?.status).toBe('missing')
  })

  it('formats a markdown report with recommendations', () => {
    const report = analyzePromptQuality([
      section('coreRules', '你是 q-code，一个有工具调用能力的 AI 助手。')
    ])
    const markdown = formatPromptQualityMarkdown(report)

    expect(markdown).toContain('# Prompt Quality Report')
    expect(markdown).toContain('| Dimension | Status | Evidence | Gaps |')
    expect(markdown).toContain('## Recommendations')
    expect(markdown).toContain('[missing]')
  })

  it('can analyze sections produced by the system prompt builder', () => {
    const builder = createSystemPromptBuilder()
    const inspections = builder.inspect(baseCtx({
      agentMdContext: '项目指令：不要泄露密钥，安全权限边界清晰。复杂任务使用 Plan Mode，验证不通过不得声明完成。测试以 pnpm typecheck 收尾。项目记忆 MEMORY.md 通过 transient 注入；忽略记忆时不注入。输出 Markdown 时保持质量和设计约束。提供 Good/BAD 示例。',
      agentsContext: 'SubAgent 可用于宽搜索。Skills 可按需加载。Hooks、Eval、Output Styles 是 q-code 领域概念。'
    }))
    const report = analyzePromptQuality(sectionsFromInspection(inspections))

    expect(report.summary.total).toBe(12)
    expect(report.checks.find((check) => check.id === 'tool-contract')?.status).not.toBe('missing')
    expect(report.checks.find((check) => check.id === 'memory-boundary')?.status).not.toBe('missing')
  })
})
