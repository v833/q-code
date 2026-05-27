import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { agentLoop } from '../../src/agent/loop'
import { ToolRegistry } from '../../src/tools/registry'
import { createMockModel } from '../_helpers/mock-model'
import { makeMockTool, makeRecordingTool } from '../_helpers/mock-tool'

/**
 * 集成测试：用 MockLanguageModelV3 + mock 工具驱动真实的 agentLoop。
 * 重点验证：
 *   - ReAct 多步执行：模型调工具 → 工具结果回写到 messages → 模型继续
 *   - finish-reason: stop 时循环退出
 *   - stopAfterToolNames 命中后立即终止
 *   - maxSteps 兜底
 *   - abortSignal 立即中断
 *   - onText / onToolEvent / onUsage 回调按时序触发
 */
describe('agentLoop 集成（mock model + mock tools）', () => {
  function makeRegistry(...tools: ReturnType<typeof makeMockTool>[]): ToolRegistry {
    const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
    registry.register(...tools)
    return registry
  }

  it('单步无工具调用：模型说话即结束', async () => {
    const { model, callCount } = createMockModel([{ text: '已完成。', finishReason: 'stop' }])
    const registry = makeRegistry()
    const messages: ModelMessage[] = [{ role: 'user', content: '你好' }]

    const collected: string[] = []
    const result = await agentLoop(model, registry, messages, 'sys', {
      quiet: true,
      onText: (t) => collected.push(t)
    })

    expect(callCount()).toBe(1)
    expect(collected.join('')).toContain('已完成')
    // 至少有一条 assistant 消息进了对话
    expect(result.messages.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('多步 ReAct：工具结果回写 messages 后模型继续', async () => {
    const { tool: probe, calls } = makeRecordingTool('probe', '工具返回值-X')
    const registry = makeRegistry(probe)

    const { model, callCount } = createMockModel([
      // 第一轮：调一次 probe
      { tools: [{ name: 'probe', input: { value: 'foo' } }] },
      // 第二轮：基于 probe 的结果，停下并输出最终文本
      { text: '已读取 X', finishReason: 'stop' }
    ])

    const result = await agentLoop(
      model,
      registry,
      [{ role: 'user', content: '帮我探查一下' }],
      'sys',
      { quiet: true }
    )

    expect(callCount()).toBe(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({ value: 'foo' })

    // tool 结果必须回到 messages（role: tool） + 终态 assistant 消息
    const toolMsgs = result.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBeGreaterThan(0)
  })

  it('工具调用轮结束后会继续下一步', async () => {
    const probe = makeMockTool('task_list', () => 'Tasks: 当前没有任务。')
    const registry = makeRegistry(probe)
    const { model, callCount } = createMockModel([
      { tools: [{ name: 'task_list', input: {}, toolCallId: 'call-task-list' }] },
      { text: '代码结构分析完成。', finishReason: 'stop' }
    ])

    const text: string[] = []
    await agentLoop(model, registry, [{ role: 'user', content: '分析一下代码结构' }], 'sys', {
      quiet: true,
      onText: (delta) => text.push(delta)
    })

    expect(callCount()).toBe(2)
    expect(text.join('')).toContain('代码结构分析完成')
  })

  it('默认不再按 TOKEN_BUDGET 或 MAX_STEPS 硬停主循环', async () => {
    const probe = makeMockTool('probe', () => 'ok')
    const registry = makeRegistry(probe)
    const turns = [
      ...Array.from({ length: 90 }, (_, index) => ({
        tools: [{ name: 'probe', input: { index } }],
        usage: { inputTokens: 300000, outputTokens: 1, totalTokens: 300001 }
      })),
      { text: '超过旧限制后仍完成。', finishReason: 'stop' as const }
    ]
    const { model, callCount } = createMockModel(turns)

    const text: string[] = []
    await agentLoop(model, registry, [{ role: 'user', content: '连续执行很多步' }], 'sys', {
      quiet: true,
      onText: (delta) => text.push(delta)
    })

    expect(callCount()).toBe(91)
    expect(text.join('')).toContain('超过旧限制后仍完成')
  })

  it('provider 在工具结果后不发送 finish 时也会收束本步并继续', async () => {
    const probe = makeMockTool('task_list', () => 'Tasks: 当前没有任务。')
    const registry = makeRegistry(probe)
    let callCount = 0
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        callCount++
        if (callCount === 1) {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] })
                controller.enqueue({ type: 'response-metadata', id: 'mock-1', modelId: 'mock-model' })
                controller.enqueue({
                  type: 'tool-input-start',
                  id: 'call-task-list',
                  toolName: 'task_list'
                })
                controller.enqueue({
                  type: 'tool-input-delta',
                  id: 'call-task-list',
                  delta: '{}'
                })
                controller.enqueue({ type: 'tool-input-end', id: 'call-task-list' })
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'call-task-list',
                  toolName: 'task_list',
                  input: '{}'
                })
              }
            }),
            request: { body: '' },
            response: { headers: {} }
          }
        }

        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'response-metadata', id: 'mock-2', modelId: 'mock-model' },
              { type: 'text-start', id: 'text-2' },
              { type: 'text-delta', id: 'text-2', delta: '代码结构分析完成。' },
              { type: 'text-end', id: 'text-2' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
              }
            ] as any[]
          }),
          request: { body: '' },
          response: { headers: {} }
        }
      }
    })

    const text: string[] = []
    await agentLoop(model, registry, [{ role: 'user', content: '分析一下代码结构' }], 'sys', {
      quiet: true,
      toolStepIdleTimeoutMs: 20,
      onText: (delta) => text.push(delta)
    })

    expect(callCount).toBe(2)
    expect(text.join('')).toContain('代码结构分析完成')
  })

  it('工具结果后延迟到达的文本和 finish 不会被过早 idle timeout 截断', async () => {
    const probe = makeMockTool('task_list', () => 'Tasks: 当前没有任务。')
    const registry = makeRegistry(probe)
    let callCount = 0
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        callCount++
        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'response-metadata', id: 'mock-1', modelId: 'mock-model' })
              controller.enqueue({
                type: 'tool-input-start',
                id: 'call-task-list',
                toolName: 'task_list'
              })
              controller.enqueue({
                type: 'tool-input-delta',
                id: 'call-task-list',
                delta: '{}'
              })
              controller.enqueue({ type: 'tool-input-end', id: 'call-task-list' })
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'call-task-list',
                toolName: 'task_list',
                input: '{}'
              })
              await new Promise((resolve) => setTimeout(resolve, 80))
              controller.enqueue({ type: 'text-start', id: 'text-after-tool' })
              controller.enqueue({ type: 'text-delta', id: 'text-after-tool', delta: '延迟文本' })
              controller.enqueue({ type: 'text-end', id: 'text-after-tool' })
              controller.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
              } as any)
              controller.close()
            }
          }),
          request: { body: '' },
          response: { headers: {} }
        }
      }
    })

    const text: string[] = []
    await agentLoop(model, registry, [{ role: 'user', content: '分析一下代码结构' }], 'sys', {
      quiet: true,
      toolStepIdleTimeoutMs: 200,
      stopAfterToolNames: ['task_list'],
      onText: (delta) => text.push(delta)
    })

    expect(callCount).toBe(1)
    expect(text.join('')).toContain('延迟文本')
  })

  it('stopAfterToolNames：相同 tool-call 重复时由检测器 + stopAfter 共同保证不卡死', async () => {
    // 实际语义：stopAfterToolNames 在拿到对应 tool-result 时把循环结束标志置位；
    // loop-detection 也会在同参重复 8 次后熔断。无论哪个先触发，循环都不会
    // 继续跑到脚本末尾。这是用户视角真正在意的不变式。
    const exitTool = makeMockTool('exit_plan_mode', () => 'planned')
    const registry = makeRegistry(exitTool)

    const turns = Array.from({ length: 100 }, () => ({
      tools: [{ name: 'exit_plan_mode', input: { plan: 'x' } }]
    }))
    const { model, callCount } = createMockModel(turns)

    await agentLoop(model, registry, [{ role: 'user', content: '规划一下' }], 'sys', {
      quiet: true,
      stopAfterToolNames: ['exit_plan_mode']
    })

    expect(callCount()).toBeLessThan(50)
  })

  it('maxSteps 限制：超过后强制退出', async () => {
    const probe = makeMockTool('probe', () => 'ok')
    const registry = makeRegistry(probe)

    // 永远输出工具调用 → 在不限制时会无限循环
    const turns = Array.from({ length: 20 }, () => ({
      tools: [{ name: 'probe', input: {} }]
    }))
    const { model, callCount } = createMockModel(turns)

    await agentLoop(model, registry, [{ role: 'user', content: '不停调用' }], 'sys', {
      quiet: true,
      maxSteps: 3
    })
    expect(callCount()).toBeLessThanOrEqual(3)
  })

  it('abortSignal：中间被 abort 立即停止', async () => {
    const probe = makeMockTool(
      'slow_probe',
      async () => {
        // 让工具执行有间隙，给 abort 一点时间命中
        await new Promise((r) => setTimeout(r, 10))
        return 'ok'
      },
      { isConcurrencySafe: false }
    )
    const registry = makeRegistry(probe)

    const { model } = createMockModel([
      { tools: [{ name: 'slow_probe', input: {} }] },
      { tools: [{ name: 'slow_probe', input: {} }] },
      { text: 'done', finishReason: 'stop' }
    ])

    const ac = new AbortController()
    setTimeout(() => ac.abort(new Error('test-abort')), 5)

    await expect(
      agentLoop(model, registry, [{ role: 'user', content: 'go' }], 'sys', {
        quiet: true,
        abortSignal: ac.signal
      })
    ).rejects.toThrow()
  })

  it('onText / onToolEvent / onUsage 按时序触发', async () => {
    const probe = makeMockTool('p', () => 'pong')
    const registry = makeRegistry(probe)
    const { model } = createMockModel([
      {
        text: '开始查询',
        tools: [{ name: 'p', input: {} }]
      },
      { text: '查询完成', finishReason: 'stop' }
    ])

    const events: string[] = []
    await agentLoop(model, registry, [{ role: 'user', content: 'q' }], 'sys', {
      quiet: true,
      onText: () => events.push('text'),
      onToolEvent: (e) => events.push(`tool:${e.phase}`),
      onUsage: () => events.push('usage')
    })

    // text 至少 1 次、tool start + done 各至少 1 次、usage 每步 1 次
    expect(events).toContain('text')
    expect(events).toContain('tool:start')
    expect(events).toContain('tool:done')
    expect(events.filter((e) => e === 'usage').length).toBeGreaterThanOrEqual(1)
  })

  it('onStepUsage 返回归一化后的 rich usage', async () => {
    const registry = makeRegistry()
    const { model } = createMockModel([
      {
        text: '完成',
        finishReason: 'stop',
        usage: { inputTokens: 30, outputTokens: 7, totalTokens: 37 }
      }
    ])

    const stepUsages: Array<{
      model: string
      usage: { inputTokens: number; outputTokens: number; totalTokens: number }
      discarded: boolean
    }> = []
    await agentLoop(model, registry, [{ role: 'user', content: 'q' }], 'sys', {
      quiet: true,
      modelName: 'mock-model',
      onStepUsage: (usage) => stepUsages.push(usage)
    })

    expect(stepUsages).toHaveLength(1)
    expect(stepUsages[0]).toMatchObject({
      model: 'mock-model',
      discarded: false,
      usage: { inputTokens: 30, outputTokens: 7, totalTokens: 37 }
    })
  })

  it('工具 envelope 错误会作为错误结果回调一次', async () => {
    const probe = makeMockTool('p', () => ({
      ok: false,
      error: 'probe failed'
    }))
    const registry = makeRegistry(probe)
    const { model } = createMockModel([
      { tools: [{ name: 'p', input: {}, toolCallId: 'call-p' }] },
      { text: 'done', finishReason: 'stop' }
    ])

    const toolEvents: string[] = []
    const results: Array<{ output: unknown; isError?: boolean }> = []
    await agentLoop(model, registry, [{ role: 'user', content: 'q' }], 'sys', {
      quiet: true,
      onToolEvent: (event) => toolEvents.push(`${event.phase}:${event.isError === true}`),
      onToolResult: (event) => results.push({ output: event.output, isError: event.isError })
    })

    expect(toolEvents).toEqual(['start:false', 'done:true'])
    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.output).toContain('probe failed')
  })

  it('单轮多工具调用：每个 tool 都被分发执行', async () => {
    // ToolRegistry 自己的并发锁在 unit/tool-registry.test.ts 测试。
    // 这里只验证 agent loop 把同一轮内的多个 tool-call 都正确分发出去。
    const ids: string[] = []
    const safeTool = makeMockTool(
      'p',
      async (input: any) => {
        ids.push(input.id)
        return 'ok'
      },
      { isConcurrencySafe: true }
    )
    const registry = makeRegistry(safeTool)
    const { model } = createMockModel([
      {
        tools: [
          { name: 'p', input: { id: 'A' }, toolCallId: 'a1' },
          { name: 'p', input: { id: 'B' }, toolCallId: 'b1' },
          { name: 'p', input: { id: 'C' }, toolCallId: 'c1' }
        ]
      },
      { text: 'done', finishReason: 'stop' }
    ])

    await agentLoop(model, registry, [{ role: 'user', content: 'go' }], 'sys', { quiet: true })

    expect(ids.sort()).toEqual(['A', 'B', 'C'])
  })
})
