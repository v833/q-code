import { describe, expect, it } from 'vitest'
import {
  parseMarkdownInline,
  renderInlineSegmentsAnsi,
  renderInlineSegmentsPlain
} from '../../src/terminal/utils/markdown-inline'

describe('markdown inline semantic parser', () => {
  it('preserves explicit markdown semantics', () => {
    const segments = parseMarkdownInline('**重点**、*提示*、`code` 和 [文档](https://example.com)')

    expect(segments.map((segment) => segment.type)).toEqual([
      'strong',
      'text',
      'emphasis',
      'text',
      'inlineCode',
      'text',
      'link'
    ])
    expect(renderInlineSegmentsPlain(segments)).toBe('重点、提示、code 和 文档 (https://example.com)')
  })

  it('detects file references and line numbers conservatively', () => {
    const segments = parseMarkdownInline(
      '改 src/foo.ts:123:45 和 C:\\repo\\src\\bar.ts:9，参考 /repo/app/index.ts'
    )

    expect(segments).toEqual([
      { type: 'text', text: '改 ' },
      { type: 'fileRef', text: 'src/foo.ts:123:45', path: 'src/foo.ts', line: 123, column: 45 },
      { type: 'text', text: ' 和 ' },
      { type: 'fileRef', text: 'C:\\repo\\src\\bar.ts:9', path: 'C:\\repo\\src\\bar.ts', line: 9 },
      { type: 'text', text: '，参考 ' },
      { type: 'fileRef', text: '/repo/app/index.ts', path: '/repo/app/index.ts' }
    ])
  })

  it('keeps markdown file links readable in plain text', () => {
    const segments = parseMarkdownInline('See [README](README.md) and [src/foo.ts:7](src/foo.ts#L7).')

    expect(renderInlineSegmentsPlain(segments)).toBe('See README (README.md) and src/foo.ts:7.')
    expect(segments.some((segment) => segment.type === 'fileRef' && segment.path === 'README.md')).toBe(true)
  })

  it('detects markdown file links with GitHub line anchors as file refs', () => {
    const segments = parseMarkdownInline('See [docs](src/foo.ts#L7C2).')

    expect(segments).toMatchObject([
      { type: 'text', text: 'See ' },
      { type: 'fileRef', text: 'docs (src/foo.ts:7:2)', path: 'src/foo.ts', line: 7, column: 2, label: 'docs' },
      { type: 'text', text: '.' }
    ])
    expect(renderInlineSegmentsPlain(segments)).toBe('See docs (src/foo.ts:7:2).')
  })

  it('keeps urls distinct from file paths and issue refs', () => {
    const segments = parseMarkdownInline('见 https://github.com/v833/q-code/issues/49 和 #49')

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'url', 'text', 'issueRef'])
    expect(renderInlineSegmentsPlain(segments)).toBe('见 https://github.com/v833/q-code/issues/49 和 #49')
  })

  it('uses different inline ANSI palettes for light and dark themes', () => {
    const segments = parseMarkdownInline('**重点** 和 src/foo.ts:7')

    const dark = renderInlineSegmentsAnsi(segments, { theme: 'dark' })
    const light = renderInlineSegmentsAnsi(segments, { theme: 'light' })

    expect(dark).toContain('\x1b[1;38;2;103;232;249m重点\x1b[0m')
    expect(light).toContain('\x1b[1;38;2;8;145;178m重点\x1b[0m')
    expect(dark).not.toBe(light)
  })

  it('highlights high-confidence non-markdown text semantics without changing plain text', () => {
    const input = 'Error: failed at src/app.ts:12; run pnpm test; set Q_CODE_THEME=light; Done'
    const segments = parseMarkdownInline(input)

    expect(renderInlineSegmentsPlain(segments)).toBe(input)
    expect(segments.map((segment) => segment.type)).toEqual([
      'status',
      'text',
      'status',
      'text',
      'fileRef',
      'text',
      'command',
      'text',
      'envVar',
      'text',
      'status'
    ])
    expect(segments.filter((segment) => segment.type === 'status').map((segment) => segment.tone)).toEqual([
      'error',
      'error',
      'success'
    ])
  })

  it('keeps non-markdown ANSI output theme-aware for status, commands, and env vars', () => {
    const segments = parseMarkdownInline('Warning: run git status with NO_COLOR=1')

    const dark = renderInlineSegmentsAnsi(segments, { theme: 'dark' })
    const light = renderInlineSegmentsAnsi(segments, { theme: 'light' })

    expect(dark).toContain('\x1b[1;38;2;251;191;36mWarning:\x1b[0m')
    expect(dark).toContain('\x1b[1;38;2;125;211;252mgit status\x1b[0m')
    expect(dark).toContain('\x1b[38;2;251;191;36mNO_COLOR=1\x1b[0m')
    expect(light).toContain('\x1b[1;38;2;180;83;9mWarning:\x1b[0m')
    expect(light).toContain('\x1b[1;38;2;29;78;216mgit status\x1b[0m')
    expect(light).toContain('\x1b[38;2;180;83;9mNO_COLOR=1\x1b[0m')
  })

  it('avoids noisy status matches in ordinary prose', () => {
    const segments = parseMarkdownInline('to err is human; failure rate and warning signs passed through')

    expect(segments).toEqual([
      { type: 'text', text: 'to err is human; failure rate and warning signs passed through' }
    ])
  })

  it('keeps nested inline semantics when rendering ANSI emphasis', () => {
    const segments = parseMarkdownInline('**src/foo.ts:7**')
    const ansi = renderInlineSegmentsAnsi(segments, { theme: 'dark' })

    expect(ansi).toContain('\x1b[38;2;34;211;238msrc/foo.ts\x1b[0m')
    expect(ansi).toContain('\x1b[38;2;245;158;11m:7\x1b[0m')
  })

  it('does not treat ordinary uppercase words as env vars', () => {
    const segments = parseMarkdownInline('Use JSON and HTTP carefully, but Q_CODE_THEME=dark is an env var.')

    expect(segments.some((segment) => segment.type === 'envVar' && segment.text === 'JSON')).toBe(false)
    expect(segments.some((segment) => segment.type === 'envVar' && segment.text === 'HTTP')).toBe(false)
    expect(segments.some((segment) => segment.type === 'envVar' && segment.text === 'Q_CODE_THEME=dark')).toBe(true)
  })
})
