import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { microcompact } from '../../src/context/compressor'
import {
  buildOffloadManifest,
  injectOffloadManifest,
  OFFLOAD_MARKER,
  offloadLargeToolResults
} from '../../src/context/offload'
import { toolGuide, type PromptContext } from '../../src/context/prompt-builder'
import { ToolRegistry } from '../../src/tools/registry'
import { makeMockTool } from '../_helpers/mock-tool'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

function baseCtx(extra: Partial<PromptContext> = {}): PromptContext {
  return {
    toolCount: 3,
    deferredToolSummary: '',
    sessionMessageCount: 0,
    sessionId: 'jit-test',
    ...extra
  }
}

function toSlashPath(path: string): string {
  return path.replace(/\\/g, '/')
}

describe('JIT Context 工具成本阶梯与 prompt discipline', () => {
  it('ToolRegistry 按 contextCost 生成当前 active 工具成本阶梯', () => {
    const registry = new ToolRegistry({ quiet: true })
    registry.register(
      makeMockTool('glob', () => 'src/index.ts', {
        contextCost: 'low',
        resultShape: 'paths',
        jitHint: '先缩小候选文件集'
      }),
      makeMockTool('grep', () => 'src/index.ts:1: match', {
        contextCost: 'medium',
        resultShape: 'lines'
      }),
      makeMockTool('read_file', () => 'full file', {
        contextCost: 'high',
        resultShape: 'file'
      }),
      makeMockTool('mcp__docs__fetch', () => 'remote docs', {
        shouldDefer: true,
        contextCost: 'high',
        resultShape: 'web'
      })
    )

    const beforeSearch = registry.getJitToolSummary()
    expect(beforeSearch).toContain('低成本')
    expect(beforeSearch).toContain('glob(路径列表，先缩小候选文件集)')
    expect(beforeSearch).toContain('中成本')
    expect(beforeSearch).toContain('grep(匹配行)')
    expect(beforeSearch).toContain('高成本')
    expect(beforeSearch).toContain('read_file(文件内容)')
    expect(beforeSearch).not.toContain('mcp__docs__fetch')

    registry.searchTools('mcp__docs__fetch')
    expect(registry.getJitToolSummary()).toContain('mcp__docs__fetch(网页/外部内容)')
  })

  it('toolGuide 注入 JIT prompt discipline 和工具成本阶梯', () => {
    const out = toolGuide()(
      baseCtx({
        toolCount: 12,
        jitToolSummary: [
          '低成本: glob(路径列表，先缩小候选文件集)',
          '中成本: grep(匹配行)',
          '高成本: read_file(文件内容，先定位行号或范围)'
        ].join('\n')
      })
    )

    expect(out).toContain('[JIT Context Discipline]')
    expect(out).toContain('list_directory/glob → grep → read_file')
    expect(out).toContain('渐进式披露')
    expect(out).not.toContain('Agent/Explore')
    expect(out).toContain('当前工具成本阶梯')
    expect(out).toContain('高成本: read_file')
  })
})

describe('Context Offloading', () => {
  let home: TempHome

  beforeEach(() => {
    home = setupTempHome('jit-offload-')
  })

  afterEach(() => {
    home.dispose()
  })

  it('压缩前把大工具结果无损写入文件，并在上下文保留恢复 marker', async () => {
    const largeOutput = `head\n${'x'.repeat(14_000)}\ntail`
    const messages: ModelMessage[] = [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-read',
            toolName: 'read_file',
            input: { path: 'huge.log' }
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-read',
            toolName: 'read_file',
            output: { type: 'text', value: largeOutput }
          }
        ]
      }
    ]

    const result = await offloadLargeToolResults(messages, {
      cwd: home.cwd,
      sessionId: 'jit-session',
      minChars: 1000
    })

    expect(result.offloaded).toBe(1)
    expect(result.warnings).toEqual([])
    expect(result.entries[0]?.originalChars).toBe(largeOutput.length)
    const filePath = toSlashPath(result.entries[0]!.filePath)
    expect(filePath).toContain('/.sessions/projects/')
    expect(filePath).toContain('/offloads/jit-session/')
    expect(existsSync(result.entries[0]!.filePath)).toBe(true)
    expect(readFileSync(result.entries[0]!.filePath, 'utf-8')).toBe(largeOutput)

    const toolMessage = result.messages[2] as ModelMessage & { content: any[] }
    const marker = toolMessage.content[0].output.value as string
    expect(marker).toContain(OFFLOAD_MARKER)
    expect(marker).toContain('tool: read_file')
    expect(marker).toContain('tool_call_id: call-read')
    expect(marker).toContain(`file: ${result.entries[0]!.filePath}`)
    expect(marker).toContain('restore:')
    expect(marker).toContain('head')
    expect(marker).toContain('tail')

    const secondPass = await offloadLargeToolResults(result.messages, {
      cwd: home.cwd,
      sessionId: 'jit-session',
      minChars: 1000
    })
    expect(secondPass.offloaded).toBe(0)
    expect(secondPass.messages).toBe(result.messages)
  })

  it('offload 使用原子写，不留下临时文件', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'atomic-call',
            toolName: 'read_file',
            output: { type: 'text', value: 'a'.repeat(2_000) }
          }
        ]
      }
    ]

    const result = await offloadLargeToolResults(messages, {
      cwd: home.cwd,
      sessionId: 'atomic-session',
      minChars: 1000
    })

    expect(result.offloaded).toBe(1)
    const filePath = toSlashPath(result.entries[0]!.filePath)
    const offloadDir = join(
      home.cwd,
      '.sessions',
      'projects',
      filePath.split('/.sessions/projects/')[1]!.split('/offloads/')[0]!,
      'offloads',
      'atomic-session'
    )
    expect(readdirSync(offloadDir).some((name) => name.includes('.tmp-'))).toBe(false)
  })

  it('offload 写盘失败时保留原工具结果并返回 warning', async () => {
    const storageAsFile = join(home.root, 'not-a-directory')
    writeFileSync(storageAsFile, 'block mkdir', 'utf-8')
    const largeOutput = 'z'.repeat(2_000)
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'failing-call',
            toolName: 'read_file',
            output: { type: 'text', value: largeOutput }
          }
        ]
      }
    ]

    const result = await offloadLargeToolResults(messages, {
      cwd: home.cwd,
      sessionId: 'fail-session',
      storageDir: storageAsFile,
      minChars: 1000
    })

    expect(result.offloaded).toBe(0)
    expect(result.warnings[0]).toContain('failed to offload read_file')
    expect(result.messages).toBe(messages)
  })

  it('只把完整内部 marker 识别为已 offload，普通同前缀输出仍会卸载', async () => {
    const markerLikeOutput = `${OFFLOAD_MARKER}\nthis is ordinary tool output\n${'x'.repeat(2_000)}`
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'marker-like',
            toolName: 'read_file',
            output: { type: 'text', value: markerLikeOutput }
          }
        ]
      }
    ]

    const result = await offloadLargeToolResults(messages, {
      cwd: home.cwd,
      sessionId: 'marker-like-session',
      minChars: 1000
    })

    expect(result.offloaded).toBe(1)
    expect(readFileSync(result.entries[0]!.filePath, 'utf-8')).toBe(markerLikeOutput)
  })

  it('摘要后会确定性注入 offload index，避免路径依赖 LLM 摘要保留', async () => {
    const entries = [
      {
        filePath: '/tmp/offloads/tool-result-0001.txt',
        originalChars: 24000,
        toolName: 'read_file',
        toolCallId: 'call-1'
      }
    ]
    const summarized: ModelMessage[] = [
      {
        role: 'user',
        content: '[以下是之前对话的压缩摘要]\n\n摘要没有提到 offload 文件。\n\n[摘要结束，以下是最近的对话]'
      },
      { role: 'user', content: '继续' }
    ]

    const injected = injectOffloadManifest(summarized, entries)
    expect(injected.injected).toBe(true)
    expect(injected.messages).toHaveLength(3)
    expect(injected.messages[1]?.content).toContain('[context offload index]')
    expect(injected.messages[1]?.content).toContain('/tmp/offloads/tool-result-0001.txt')
    expect(buildOffloadManifest(entries)).toContain('original_chars: 24000')
  })

  it('microcompact 不会清理已经 offload 的恢复路径', () => {
    const marker = [
      OFFLOAD_MARKER,
      'tool: read_file',
      'original_chars: 14000',
      'file: /tmp/offloaded-tool-result.txt',
      'restore: use read_file'
    ].join('\n')
    const messages: ModelMessage[] = Array.from({ length: 4 }, (_, index) => ({
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result',
          toolCallId: `call-${index}`,
          toolName: 'read_file',
          output: { type: 'text', value: marker }
        }
      ]
    }))

    const compacted = microcompact(messages)
    expect(compacted.cleared).toBe(0)
    expect(compacted.messages).toBe(messages)
  })
})
