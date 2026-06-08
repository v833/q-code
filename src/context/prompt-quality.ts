/**
 * Agent Prompt 质量基线：把 system prompt 分段映射到可审计的行为维度。
 */
import type { PromptSectionInspection } from './prompt-builder'

/** Prompt 质量检查状态。 */
export type PromptQualityStatus = 'pass' | 'warn' | 'missing'

/** 可参与质量审计的 prompt 片段。 */
export interface PromptQualitySection {
  name: string
  text: string
  enabled: boolean
}

/** 单条 prompt 质量维度定义。 */
export interface PromptQualityDimension {
  id: string
  title: string
  intent: string
  requiredEvidence: string[]
  recommendedEvidence: string[]
}

/** 单条 prompt 质量检查结果。 */
export interface PromptQualityCheck {
  id: string
  title: string
  intent: string
  status: PromptQualityStatus
  evidence: string[]
  gaps: string[]
  recommendation: string
}

/** Prompt 质量报告。 */
export interface PromptQualityReport {
  ok: boolean
  summary: {
    pass: number
    warn: number
    missing: number
    total: number
  }
  checks: PromptQualityCheck[]
}

interface EvidenceHit {
  label: string
  matched: boolean
}

const DIMENSIONS: PromptQualityDimension[] = [
  {
    id: 'identity',
    title: '身份与运行形态',
    intent: '模型应知道自己是 q-code、运行在 CLI/TUI 场景中，并服务代码 Agent 任务。',
    requiredEvidence: ['你是 q-code', 'AI 助手'],
    recommendedEvidence: ['CLI', 'TUI', '工具调用能力']
  },
  {
    id: 'security-boundary',
    title: '安全边界',
    intent: '安全规则应覆盖权限、敏感信息、危险操作与拒绝策略。',
    requiredEvidence: ['安全', '密钥', '权限'],
    recommendedEvidence: ['拒绝', '敏感', '危险']
  },
  {
    id: 'tool-contract',
    title: '工具调用契约',
    intent: '工具规则应说明何时读取、何时搜索、何时串行或并行，以及失败后如何换路。',
    requiredEvidence: ['toolDiscipline', '工具', 'grep', 'read_file'],
    recommendedEvidence: ['并行', '串行', '失败', '不要调用当前工具列表中不存在']
  },
  {
    id: 'workflow-gates',
    title: '工作流阶段门',
    intent: '复杂任务应具备理解、规划、执行、验证和交付的阶段约束。',
    requiredEvidence: ['Plan Mode', '验证', '完成'],
    recommendedEvidence: ['in_progress', 'completed', '计划']
  },
  {
    id: 'output-contract',
    title: '输出格式与界面契约',
    intent: '输出应适配终端界面，包含进度说明、最终摘要和克制格式。',
    requiredEvidence: ['进度说明', '简洁直接'],
    recommendedEvidence: ['最终', 'Markdown', 'TUI']
  },
  {
    id: 'editing-contract',
    title: '最小编辑与验证闭环',
    intent: '代码编辑应先读后改、最小变更，并以测试或类型检查收尾。',
    requiredEvidence: ['先读文件再修改', '测试'],
    recommendedEvidence: ['typecheck', '最小', '验证不通过不得声明']
  },
  {
    id: 'memory-boundary',
    title: '项目记忆边界',
    intent: '记忆应区分索引、正文、写入触发和忽略记忆场景。',
    requiredEvidence: ['项目记忆', 'memory'],
    recommendedEvidence: ['transient', '忽略记忆', 'MEMORY.md']
  },
  {
    id: 'communication-levels',
    title: '沟通分级',
    intent: 'Agent 应区分非阻塞进度通知与阻塞式提问，减少无谓打扰。',
    requiredEvidence: ['进度说明', '问'],
    recommendedEvidence: ['先探索', '澄清', '确认']
  },
  {
    id: 'domain-knowledge',
    title: 'q-code 领域知识',
    intent: 'Prompt 应注入 q-code 的 CLI、工具、Skills、SubAgent、Hooks、Eval 等本体概念。',
    requiredEvidence: ['q-code', 'Skills', 'SubAgent'],
    recommendedEvidence: ['Hooks', 'Eval', 'Output Styles']
  },
  {
    id: 'few-shot-alignment',
    title: '正反例对齐',
    intent: '对易错行为用少量 good/bad example 钉住边界，避免抽象规则漂移。',
    requiredEvidence: ['示例', '例'],
    recommendedEvidence: ['Good', 'BAD', '正反例']
  },
  {
    id: 'failure-recovery',
    title: '失败恢复阶梯',
    intent: '失败后应核实参数、按错误修复、换方法，最后再求助用户。',
    requiredEvidence: ['失败', '换一个思路'],
    recommendedEvidence: ['重试', '求助', '错误']
  },
  {
    id: 'quality-constraints',
    title: '品质量化约束',
    intent: '前端、文档和用户可见输出应有可执行的质量规则，而不是只写“更好”。',
    requiredEvidence: ['质量', '设计'],
    recommendedEvidence: ['禁用', '最多', '不要']
  }
]

/** 返回 q-code Prompt 质量基线的 12 个审计维度。 */
export function getPromptQualityDimensions(): PromptQualityDimension[] {
  return DIMENSIONS.map((dimension) => ({
    ...dimension,
    requiredEvidence: [...dimension.requiredEvidence],
    recommendedEvidence: [...dimension.recommendedEvidence]
  }))
}

/** 将 PromptBuilder inspection 结果转换为质量审计片段。 */
export function sectionsFromInspection(
  sections: PromptSectionInspection[]
): PromptQualitySection[] {
  return sections.map((section) => ({
    name: section.name,
    text: section.text,
    enabled: section.enabled
  }))
}

/** 基于 prompt 片段生成质量报告。 */
export function analyzePromptQuality(
  sections: PromptQualitySection[],
  dimensions: PromptQualityDimension[] = DIMENSIONS
): PromptQualityReport {
  const enabledSections = sections.filter((section) => section.enabled)
  const checks = dimensions.map((dimension) => evaluateDimension(dimension, enabledSections))
  const summary = {
    pass: checks.filter((check) => check.status === 'pass').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    missing: checks.filter((check) => check.status === 'missing').length,
    total: checks.length
  }

  return {
    ok: summary.missing === 0,
    summary,
    checks
  }
}

/** 格式化为人类可读的 Markdown 报告。 */
export function formatPromptQualityMarkdown(report: PromptQualityReport): string {
  const lines = [
    '# Prompt Quality Report',
    '',
    `Summary: ${report.summary.pass} pass / ${report.summary.warn} warn / ${report.summary.missing} missing`,
    '',
    '| Dimension | Status | Evidence | Gaps |',
    '| --- | --- | --- | --- |'
  ]

  for (const check of report.checks) {
    lines.push(
      `| ${check.title} | ${check.status} | ${formatTableCell(check.evidence)} | ${formatTableCell(check.gaps)} |`
    )
  }

  lines.push('', '## Recommendations', '')
  for (const check of report.checks.filter((item) => item.status !== 'pass')) {
    lines.push(`- [${check.status}] ${check.title}: ${check.recommendation}`)
  }

  if (report.checks.every((check) => check.status === 'pass')) {
    lines.push('- All dimensions have required and recommended evidence.')
  }

  return lines.join('\n')
}

function evaluateDimension(
  dimension: PromptQualityDimension,
  sections: PromptQualitySection[]
): PromptQualityCheck {
  const required = dimension.requiredEvidence.map((label) => findEvidence(label, sections))
  const recommended = dimension.recommendedEvidence.map((label) => findEvidence(label, sections))
  const requiredHits = required.filter((hit) => hit.matched)
  const recommendedHits = recommended.filter((hit) => hit.matched)
  const evidence = [...requiredHits, ...recommendedHits].map((hit) => hit.label)
  const gaps = [...required, ...recommended]
    .filter((hit) => !hit.matched)
    .map((hit) => hit.label)
  const status = requiredHits.length === 0
    ? 'missing'
    : gaps.length === 0
      ? 'pass'
      : 'warn'

  return {
    id: dimension.id,
    title: dimension.title,
    intent: dimension.intent,
    status,
    evidence,
    gaps,
    recommendation: createRecommendation(dimension, gaps)
  }
}

function findEvidence(label: string, sections: PromptQualitySection[]): EvidenceHit {
  const normalizedLabel = label.toLocaleLowerCase()
  const matched = sections.some((section) => {
    if (section.name.toLocaleLowerCase().includes(normalizedLabel)) return true
    return section.text.toLocaleLowerCase().includes(normalizedLabel)
  })

  return { label, matched }
}

function createRecommendation(dimension: PromptQualityDimension, gaps: string[]): string {
  if (gaps.length === 0) return '已覆盖必需证据与推荐证据。'
  return `补齐 ${dimension.id} 维度的证据：${gaps.join('、')}。`
}

function formatTableCell(values: string[]): string {
  if (values.length === 0) return '-'
  return values.join(', ').replace(/\|/g, '\\|')
}
