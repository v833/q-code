import { describe, expect, it } from 'vitest'
import { formatAgentMdContent, formatAgentMdSections } from '../../src/context/agent-md'

describe('agent md prompt formatting', () => {
  it('keeps short AGENTS content unchanged', () => {
    const content = ['# Project', '', 'Short local instructions.'].join('\n')

    expect(formatAgentMdContent(content, { fullCharLimit: 200 })).toBe(content)
  })

  it('summarizes long AGENTS content while preserving important sections', () => {
    const content = [
      '# q-code 项目协作说明',
      '',
      'Intro text that should stay.',
      '',
      '## 实现约定',
      '- 先读文件再修改。',
      '- 不要暴露密钥。',
      '',
      '## 目录边界',
      'A'.repeat(600),
      '',
      '## 测试策略',
      '- 运行相关测试。',
      '',
      '## 其它长文',
      'B'.repeat(600)
    ].join('\n')

    const out = formatAgentMdContent(content, {
      fullCharLimit: 400,
      sectionCharLimit: 120
    })

    expect(out).toContain('<agent-md-summary>')
    expect(out).toContain('## 实现约定')
    expect(out).toContain('## 测试策略')
    expect(out).toContain('## 目录边界')
    expect(out).toContain('## 其它长文')
    expect(out).toContain('完整内容请读取')
  })

  it('keeps English and custom headings as deterministic excerpts', () => {
    const content = [
      '# Repository Guidelines',
      '',
      'Intro text should stay because the preamble is important.',
      '',
      '## Security',
      '- Do not print secrets.',
      '- Validate paths before reading files.',
      '',
      '## Testing',
      '- Run the focused tests.',
      '',
      '## Custom Local Notes',
      'C'.repeat(500)
    ].join('\n')

    const out = formatAgentMdContent(content, {
      fullCharLimit: 180,
      sectionCharLimit: 140
    })

    expect(out).toContain('## Security')
    expect(out).toContain('Do not print secrets')
    expect(out).toContain('## Testing')
    expect(out).toContain('Run the focused tests')
    expect(out).toContain('## Custom Local Notes')
    expect(out).toContain('完整内容请读取')
  })

  it('keeps source headers when formatting multiple sections', () => {
    const out = formatAgentMdSections(
      [
        {
          filePath: '/repo/AGENTS.md',
          content: ['# Project', '', '## 实现约定', 'A'.repeat(300)].join('\n')
        }
      ],
      { fullCharLimit: 80, sectionCharLimit: 80 }
    )

    expect(out).toContain('# Source: /repo/AGENTS.md')
    expect(out).toContain('<agent-md-summary>')
  })
})
