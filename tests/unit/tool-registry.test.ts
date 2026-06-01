import { afterEach, describe, expect, it } from 'vitest'
import { ToolRegistry, errorToolResult, truncateResult } from '../../src/tools/registry'
import { makeMockTool, makeRecordingTool } from '../_helpers/mock-tool'
import { DefaultHookRunner } from '../../src/hooks'
import { resetAuditLoggerForTests, type AuditLogger } from '../../src/observability/audit'

afterEach(() => {
  resetAuditLoggerForTests()
})

/**
 * ToolRegistry 是工具可见性与并发控制的心脏。测试覆盖：
 *   - 注册 / 检索 / 担名覆盖 / 前缀卸载
 *   - Plan Mode 不可见过滤（只读工具 + allowInPlanMode 除外）
 *   - 延迟工具的 tool_search 按名注册 + 多名逗号表达式
 *   - toAISDKFormat 执行时的并发锁（独占 / 共享）
 *   - cwd / abortSignal / teammateIdentity 透传
 *   - 过长输出被截断
 */
describe('ToolRegistry 工具注册表与并发控制', () => {
  describe('注册 / 检索', () => {
    it('按名注册与检索工具', () => {
      const registry = new ToolRegistry({ cwd: '/tmp' })
      const a = makeMockTool('a', () => 'ok')
      const b = makeMockTool('b', () => 'ok')
      registry.register(a, b)
      expect(registry.get('a')).toBe(a)
      expect(registry.get('b')).toBe(b)
      expect(registry.getAll()).toHaveLength(2)
    })

    it('同名重复注册覆盖原有工具', () => {
      const registry = new ToolRegistry()
      registry.register(makeMockTool('x', () => 'first'))
      registry.register(makeMockTool('x', () => 'second'))
      expect(registry.getAll()).toHaveLength(1)
    })

    it('unregisterByPrefix 按前缀批量移除', () => {
      const registry = new ToolRegistry()
      registry.register(
        makeMockTool('mcp__a__t1', () => 'ok'),
        makeMockTool('mcp__a__t2', () => 'ok'),
        makeMockTool('local__keep', () => 'ok')
      )
      const removed = registry.unregisterByPrefix('mcp__a__')
      expect(removed).toBe(2)
      expect(registry.getAll().map((t) => t.name)).toEqual(['local__keep'])
    })
  })

  describe('Plan Mode 可见性过滤', () => {
    it('Plan Mode 下隐藏写入工具，只保留只读与 allowInPlanMode', () => {
      const registry = new ToolRegistry()
      registry.register(
        makeMockTool('read_file', () => 'ok', { isReadOnly: true }),
        makeMockTool('write_file', () => 'ok', { isReadOnly: false }),
        makeMockTool('bash', () => 'ok', { isReadOnly: false }),
        makeMockTool('plan_write', () => 'ok', {
          isReadOnly: false,
          allowInPlanMode: true
        })
      )
      registry.setMode('plan')
      const visible = registry
        .getVisibleTools()
        .map((t) => t.name)
        .sort()
      expect(visible).toEqual(['plan_write', 'read_file'])
    })

    it('normal 模式下隐藏 plan-mode 专用工具（plan_write / exit_plan_mode）', () => {
      const registry = new ToolRegistry()
      registry.register(
        makeMockTool('plan_write', () => 'ok', { allowInPlanMode: true }),
        makeMockTool('exit_plan_mode', () => 'ok', { allowInPlanMode: true }),
        makeMockTool('read_file', () => 'ok', { isReadOnly: true })
      )
      registry.setMode('normal')
      const visible = registry
        .getVisibleTools()
        .map((t) => t.name)
        .sort()
      expect(visible).toEqual(['read_file'])
    })

    it('尊重 isEnabled() 门控', () => {
      const registry = new ToolRegistry()
      let enabled = false
      registry.register(makeMockTool('Conditional', () => 'ok', { isEnabled: () => enabled }))
      expect(registry.getVisibleTools()).toHaveLength(0)
      enabled = true
      expect(registry.getVisibleTools()).toHaveLength(1)
    })
  })

  describe('延迟工具（tool_search 按需注册）', () => {
    it('延迟工具未被 search 前不进入 active 集合', () => {
      const registry = new ToolRegistry()
      registry.register(
        makeMockTool('immediate', () => 'ok'),
        makeMockTool('mcp__github__create_issue', () => 'ok', {
          shouldDefer: true,
          searchHint: 'github tool'
        })
      )
      expect(registry.getActiveTools().map((t) => t.name)).toEqual(['immediate'])
      const summary = registry.getDeferredToolSummary()
      expect(summary).toContain('mcp__github__create_issue')

      const found = registry.searchTools('mcp__github__create_issue')
      expect(found).toHaveLength(1)
      expect(registry.getActiveTools().map((t) => t.name)).toContain('mcp__github__create_issue')
    })

    it('searchTools 支持逗号分隔多名查询', () => {
      const registry = new ToolRegistry()
      registry.register(
        makeMockTool('a', () => 'ok', { shouldDefer: true }),
        makeMockTool('b', () => 'ok', { shouldDefer: true }),
        makeMockTool('c', () => 'ok', { shouldDefer: true })
      )
      const found = registry.searchTools('a,c')
      expect(found.map((t) => t.name).sort()).toEqual(['a', 'c'])
      expect(
        registry
          .getActiveTools()
          .map((t) => t.name)
          .sort()
      ).toEqual(['a', 'c'])
    })
  })

  describe('本轮工具过滤', () => {
    it('allowedToolNames 同步收窄 active tools、token estimate 和 AI SDK schema', () => {
      const registry = new ToolRegistry()
      registry.register(
        makeMockTool('read_file', () => 'ok'),
        makeMockTool('write_file', () => 'ok')
      )
      const allowedToolNames = new Set(['read_file'])

      expect(registry.getActiveTools({ allowedToolNames }).map((tool) => tool.name)).toEqual(['read_file'])
      expect(registry.countTokenEstimate({ allowedToolNames }).active)
        .toBeLessThan(registry.countTokenEstimate().active)
      expect(Object.keys(registry.toAISDKFormat({}, { allowedToolNames }))).toEqual(['read_file'])
    })
  })

  describe('toAISDKFormat — 并发锁', () => {
    it('非并发安全工具独占执行（同时仅 1 个）', async () => {
      const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
      const order: string[] = []
      let inFlight = 0
      let maxInFlight = 0

      registry.register(
        makeMockTool(
          'write',
          async () => {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            order.push('start')
            await new Promise((r) => setTimeout(r, 5))
            order.push('end')
            inFlight--
            return 'done'
          },
          { isConcurrencySafe: false }
        )
      )
      const tools = registry.toAISDKFormat()
      await Promise.all([
        tools.write.execute({}, { toolCallId: '1', messages: [] }),
        tools.write.execute({}, { toolCallId: '2', messages: [] }),
        tools.write.execute({}, { toolCallId: '3', messages: [] })
      ])

      expect(maxInFlight).toBe(1)
      // All tools should have completed (start, end pairs interleaved
      // would never produce 3 starts before 3 ends if exclusivity holds).
      expect(order).toEqual(['start', 'end', 'start', 'end', 'start', 'end'])
    })

    it('并发安全工具可并行执行', async () => {
      const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
      let inFlight = 0
      let maxInFlight = 0

      registry.register(
        makeMockTool(
          'read',
          async () => {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((r) => setTimeout(r, 5))
            inFlight--
            return 'ok'
          },
          { isConcurrencySafe: true }
        )
      )

      const tools = registry.toAISDKFormat()
      await Promise.all([
        tools.read.execute({}, { toolCallId: '1', messages: [] }),
        tools.read.execute({}, { toolCallId: '2', messages: [] }),
        tools.read.execute({}, { toolCallId: '3', messages: [] })
      ])

      expect(maxInFlight).toBeGreaterThanOrEqual(2)
    })

    it('透传 cwd / abortSignal / teammateIdentity 到 execute', async () => {
      const registry = new ToolRegistry({ cwd: '/should-be-overridden' })
      const { tool, calls } = makeRecordingTool('probe')
      registry.register(tool)
      const ac = new AbortController()
      const tools = registry.toAISDKFormat({
        cwd: '/scoped',
        abortSignal: ac.signal,
        teammateIdentity: { agentName: 'tester', teamName: 'unit' }
      })
      await tools.probe.execute({ value: 'hi' }, { toolCallId: '1', messages: [] })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.input).toEqual({ value: 'hi' })
      expect(calls[0]?.context.cwd).toBe('/scoped')
      expect(calls[0]?.context.abortSignal).toBe(ac.signal)
      expect(calls[0]?.context.teammateIdentity).toEqual({
        agentName: 'tester',
        teamName: 'unit'
      })
    })

    it('超限字符串输出被自动截断', async () => {
      const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
      registry.register(
        makeMockTool('huge', () => 'x'.repeat(200_000), {
          maxResultChars: 1000
        })
      )
      const tools = registry.toAISDKFormat()
      const result = await tools.huge.execute({}, { toolCallId: '1', messages: [] })
      expect(typeof result).toBe('string')
      expect((result as string).length).toBeLessThan(2000)
      expect(result).toContain('[省略')
    })

    it('pre_tool_use hook 可以改写工具输入', async () => {
      const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
      const { tool, calls } = makeRecordingTool('probe')
      const hooks = new DefaultHookRunner([
        {
          name: 'rewrite-input',
          type: 'handler',
          event: 'pre_tool_use',
          scope: 'runtime',
          handler: () => ({ action: 'modify', input: { value: 'rewritten' } })
        }
      ])
      registry.register(tool)

      const tools = registry.toAISDKFormat({ sessionId: 's1', hooks })
      await tools.probe.execute({ value: 'raw' }, { toolCallId: 'tc1', messages: [] })

      expect(calls[0]?.input).toEqual({ value: 'rewritten' })
    })

    it('pre_tool_use hook 可以阻断工具执行', async () => {
      const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
      const { tool, calls } = makeRecordingTool('probe')
      const hooks = new DefaultHookRunner([
        {
          name: 'deny',
          type: 'handler',
          event: 'pre_tool_use',
          scope: 'runtime',
          handler: () => ({ action: 'block', reason: 'policy denied' })
        }
      ])
      registry.register(tool)

      const tools = registry.toAISDKFormat({ sessionId: 's1', hooks })
      const result = await tools.probe.execute({ value: 'raw' }, { toolCallId: 'tc1', messages: [] })

      expect(calls).toHaveLength(0)
      expect(result).toContain('[hook blocked] probe 未执行')
      expect(result).toContain('policy denied')
    })

    it('post_tool_use hook 可以改写工具输出', async () => {
      const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
      registry.register(makeMockTool('probe', () => 'raw output'))
      const hooks = new DefaultHookRunner([
        {
          name: 'rewrite-output',
          type: 'handler',
          event: 'post_tool_use',
          scope: 'runtime',
          handler: () => ({ action: 'modify', output: 'rewritten output' })
        }
      ])

      const tools = registry.toAISDKFormat({ sessionId: 's1', hooks })
      const result = await tools.probe.execute({}, { toolCallId: 'tc1', messages: [] })

      expect(result).toBe('rewritten output')
    })

    it('默认把结构化工具错误渲染为兼容文本', async () => {
      const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
      registry.register(makeMockTool('danger', () => errorToolResult('policy denied', { code: 'denied' })))

      const tools = registry.toAISDKFormat()
      const result = await tools.danger.execute({}, { toolCallId: 'tc1', messages: [] })

      expect(result).toContain('[tool error]')
      expect(result).toContain('policy denied')
      expect(result).toContain('code: denied')
    })

    it('resultEnvelope 模式保留 typed ok/error envelope', async () => {
      const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
      registry.register(makeMockTool('danger', () => errorToolResult('policy denied', { code: 'denied' })))

      const tools = registry.toAISDKFormat({}, { resultEnvelope: true })
      const result = await tools.danger.execute({}, { toolCallId: 'tc1', messages: [] })

      expect(result).toMatchObject({
        ok: false,
        code: 'denied'
      })
      expect(result.error).toContain('[tool error]')
      expect(result.error).toContain('policy denied')
    })

    it('工具抛出的异常会被统一包成结构化错误', async () => {
      const auditRecords: Array<{ event: string; payload: Record<string, unknown> }> = []
      resetAuditLoggerForTests({
        emit: (event, payload = {}) => {
          auditRecords.push({ event, payload })
        },
        flush: async () => {}
      } satisfies AuditLogger)
      const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
      registry.register(makeMockTool('boom', () => {
        throw new Error('exploded')
      }))

      const tools = registry.toAISDKFormat({}, { resultEnvelope: true })
      const result = await tools.boom.execute({}, { toolCallId: 'tc1', messages: [] })

      expect(result).toMatchObject({
        ok: false,
        code: 'tool_exception'
      })
      expect(result.error).toContain('exploded')
      const auditResult = auditRecords.find(
        (record) => record.event === 'tool.result' && record.payload.code === 'tool_exception'
      )
      expect(auditResult?.payload.durationMs).toBeTypeOf('number')
    })
  })
})

describe('truncateResult 头尾保留截断', () => {
  it('短字符串原样返回', () => {
    expect(truncateResult('hello', 100)).toBe('hello')
  })

  it('超限时保留头部 + 尾部两段', () => {
    const text = 'A'.repeat(60) + 'B'.repeat(40)
    const out = truncateResult(text, 50)
    expect(out).toContain('A')
    expect(out).toContain('B')
    expect(out).toContain('[省略')
  })
})
