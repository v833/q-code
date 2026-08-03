import { describe, expect, it } from 'vitest'
import {
  ExecArgsError,
  composeExecPrompt,
  parseExecArgs,
} from '../../src/cli/exec-args'

describe('Codex-compatible exec args', () => {
  it('parses the agent-os first-turn invocation', () => {
    expect(parseExecArgs([
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '检查项目',
    ])).toMatchObject({
      action: 'run',
      prompt: '检查项目',
      json: true,
      fullAuto: true,
      skipGitRepoCheck: true,
      images: [],
    })
  })

  it('parses the agent-os resume invocation with options after session id', () => {
    expect(parseExecArgs([
      'resume',
      'thread-1',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '继续处理',
    ])).toMatchObject({
      action: 'resume',
      sessionId: 'thread-1',
      prompt: '继续处理',
      json: true,
    })
  })

  it('parses common value options and repeated images', () => {
    expect(parseExecArgs([
      '-C', 'C:\\workspace',
      '--model=gpt-test',
      '-i', 'one.png',
      '--image=two.jpg',
      '-o', 'answer.txt',
      '--color', 'never',
      '--sandbox=read-only',
      '--ephemeral',
      '--',
      '-prompt-starting-with-dash',
    ])).toMatchObject({
      action: 'run',
      cwd: 'C:\\workspace',
      model: 'gpt-test',
      images: ['one.png', 'two.jpg'],
      outputLastMessage: 'answer.txt',
      color: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      prompt: '-prompt-starting-with-dash',
    })
  })

  it('supports resume --last', () => {
    const parsed = parseExecArgs(['resume', '--last', '--json', '继续'])
    expect(parsed).toMatchObject({
      action: 'resume',
      resumeLast: true,
      prompt: '继续',
    })
    expect(parsed).not.toHaveProperty('sessionId')
  })

  it('returns help and version actions without a prompt', () => {
    expect(parseExecArgs(['--help']).action).toBe('help')
    expect(parseExecArgs(['resume', '--help']).action).toBe('resume-help')
    expect(parseExecArgs(['--version']).action).toBe('version')
  })

  it('keeps a single dash as the stdin prompt sentinel', () => {
    expect(parseExecArgs(['--json', '-']).prompt).toBe('-')
  })

  it.each([
    ['--sandbox', 'danger-full-access'],
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--add-dir', 'elsewhere'],
    ['--output-schema', 'schema.json'],
    ['--oss'],
    ['--local-provider', 'ollama'],
    ['--profile', 'work'],
    ['--config', 'model="x"'],
    ['--enable', 'feature'],
    ['--disable', 'feature'],
    ['--unknown'],
  ])('rejects unsupported args: %s', (...args) => {
    expect(() => parseExecArgs(args)).toThrow(ExecArgsError)
  })

  it('rejects ambiguous resume targets and prompts', () => {
    expect(() => parseExecArgs(['resume', '--last', 'session-1', 'prompt']))
      .toThrow(/--last/)
    expect(() => parseExecArgs(['resume', 'session-1']))
      .not.toThrow()
    expect(() => parseExecArgs(['one', 'two'])).toThrow(/PROMPT/)
    expect(() => parseExecArgs(['resume', 'session-1', '--ephemeral', 'prompt']))
      .toThrow(/ephemeral/)
  })

  it.each(['-C', '-m', '-i', '-o', '--color', '-s'])(
    'does not consume the next short option as the value for %s',
    (option) => {
      expect(() => parseExecArgs([option, '-V'])).toThrow(/需要一个值/)
    },
  )
})

describe('exec prompt composition', () => {
  it('uses stdin when prompt is omitted or a dash', () => {
    expect(composeExecPrompt(undefined, '来自 stdin\n', true)).toBe('来自 stdin')
    expect(composeExecPrompt('-', '来自 stdin\n', true)).toBe('来自 stdin')
  })

  it('appends piped stdin to an argv prompt', () => {
    expect(composeExecPrompt('检查项目', '补充上下文\n', true)).toBe(
      '检查项目\n\n<stdin>\n补充上下文\n</stdin>',
    )
  })

  it('ignores stdin when it is not piped', () => {
    expect(composeExecPrompt('检查项目', '', false)).toBe('检查项目')
  })

  it('rejects an empty resolved prompt', () => {
    expect(() => composeExecPrompt(undefined, '  \n', true)).toThrow(ExecArgsError)
    expect(() => composeExecPrompt(undefined, '', false)).toThrow(ExecArgsError)
  })
})
