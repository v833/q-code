import { describe, expect, it } from 'vitest'
import {
  CachePrefixTracker,
  UsageTracker,
  annotateCachePrefixSnapshot,
  computeCost,
  createCachePrefixSnapshot,
  normalizeUsage,
  parseCacheModeArg,
  readCacheKeepaliveIntervalMs,
  readCacheStablePrefixTarget,
  renderCacheStatus,
  renderNoUsage,
  renderUsageSummary,
  resolveModelPricing
} from '../../src/usage'
import { makeMockTool } from '../_helpers/mock-tool'

describe('usage normalization', () => {
  it('normalizes provider cache read tokens and excludes them from paid input', () => {
    expect(
      normalizeUsage({
        inputTokens: 1000,
        outputTokens: 200,
        providerMetadata: {
          openai: {
            promptTokensDetails: {
              cachedTokens: 400
            }
          }
        }
      })
    ).toEqual({
      inputTokens: 600,
      outputTokens: 200,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      totalTokens: 1200
    })
  })

  it('normalizes cache creation tokens from provider metadata', () => {
    expect(
      normalizeUsage({
        inputTokens: 100,
        outputTokens: 50,
        providerMetadata: {
          anthropic: {
            cacheCreationInputTokens: 900
          }
        }
      })
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 900,
      totalTokens: 1050
    })
  })

  it('normalizes AI SDK input token details', () => {
    expect(
      normalizeUsage({
        inputTokens: 1200,
        outputTokens: 300,
        inputTokenDetails: {
          noCacheTokens: 500,
          cacheReadTokens: 500,
          cacheWriteTokens: 200
        }
      })
    ).toEqual({
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
      totalTokens: 1500
    })
  })

  it('subtracts cache write tokens from SDK total input when noCacheTokens is unavailable', () => {
    expect(
      normalizeUsage({
        inputTokens: 1200,
        outputTokens: 300,
        inputTokenDetails: {
          cacheReadTokens: 500,
          cacheWriteTokens: 200
        }
      })
    ).toEqual({
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
      totalTokens: 1500
    })
  })
})

describe('usage pricing and totals', () => {
  it('resolves pricing by exact name and longest prefix', () => {
    expect(resolveModelPricing('gpt-5.5')).toMatchObject({ model: 'gpt-5.5' })
    expect(resolveModelPricing('gpt-5.5-2026-05-25')).toMatchObject({ model: 'gpt-5.5' })
    expect(resolveModelPricing('unknown-model')).toBeUndefined()
  })

  it('computes actual cost, no-cache baseline, and savings', () => {
    const pricing = { input: 10, output: 20, cacheWrite: 10, cacheRead: 1 }
    const cost = computeCost(
      {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 9000,
        cacheWriteTokens: 0,
        totalTokens: 10500
      },
      pricing
    )

    expect(cost?.cost).toBeCloseTo(0.029)
    expect(cost?.baselineCost).toBeCloseTo(0.11)
    expect(cost?.savedCost).toBeCloseTo(0.081)
  })

  it('tracks records with cache mode and renders a readable summary', () => {
    const tracker = new UsageTracker({ cacheMode: 'auto' })
    tracker.record('mock-model', {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      totalTokens: 2100
    })
    tracker.setCacheMode('off')
    tracker.record('unknown-model', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15
    })

    const totals = tracker.totals()
    expect(totals.steps).toBe(2)
    expect(totals.cacheMode).toBe('off')
    expect(totals.cacheHitRate).toBeCloseTo(1000 / 2010)
    expect(totals.unknownCostSteps).toBe(1)
    expect(renderUsageSummary(totals)).toContain('Cache hit')
    expect(renderUsageSummary(totals)).toContain('█')
    expect(renderUsageSummary(totals)).toContain('节省成本')
    expect(renderNoUsage()).toContain('还没有可统计')
  })

  it('restores cache mode from the latest record when no explicit mode is provided', () => {
    const tracker = new UsageTracker({
      records: [
        {
          timestamp: '2026-05-25T00:00:00.000Z',
          model: 'mock-model',
          cacheMode: 'off',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2
          }
        }
      ]
    })

    expect(tracker.getCacheMode()).toBe('off')
  })
})

describe('cache status', () => {
  it('reads cache stability and keepalive env settings conservatively', () => {
    expect(readCacheStablePrefixTarget({})).toBe(0.9)
    expect(readCacheStablePrefixTarget({ Q_CODE_CACHE_STABLE_PREFIX_TARGET: '0.95' })).toBe(0.95)
    expect(readCacheStablePrefixTarget({ Q_CODE_CACHE_STABLE_PREFIX_TARGET: '1.5' })).toBe(0.9)
    expect(readCacheStablePrefixTarget({ Q_CODE_CACHE_STABLE_PREFIX_TARGET: 'nope' })).toBe(0.9)

    expect(readCacheKeepaliveIntervalMs({})).toBe(0)
    expect(readCacheKeepaliveIntervalMs({ Q_CODE_CACHE_KEEPALIVE_INTERVAL_MS: '1' })).toBe(60000)
    expect(readCacheKeepaliveIntervalMs({ Q_CODE_CACHE_KEEPALIVE_INTERVAL_MS: '300000' })).toBe(300000)
    expect(readCacheKeepaliveIntervalMs({ Q_CODE_CACHE_KEEPALIVE_INTERVAL_MS: '-1' })).toBe(0)
  })

  it('parses supported cache modes only', () => {
    expect(parseCacheModeArg('auto')).toBe('auto')
    expect(parseCacheModeArg('ON')).toBe('on')
    expect(parseCacheModeArg('disabled')).toBeUndefined()
  })

  it('tracks prefix changes and becomes stable again after the same prefix repeats', () => {
    const tracker = new CachePrefixTracker()
    const tool = makeMockTool('probe', () => 'ok')
    const first = createCachePrefixSnapshot({
      systemPrompt: 'system-a',
      tools: [tool],
      activeToolSchemaTokens: 100
    })
    const second = createCachePrefixSnapshot({
      systemPrompt: 'system-b',
      tools: [tool],
      activeToolSchemaTokens: 100
    })

    expect(tracker.observe(first).stable).toBe(true)
    expect(tracker.observe(second)).toMatchObject({ stable: false, changes: 1 })
    expect(tracker.observe(second)).toMatchObject({ stable: true, changes: 1 })
  })

  it('reports changed prompt sections and stable prefix ratio', () => {
    const tool = makeMockTool('probe', () => 'ok')
    const first = createCachePrefixSnapshot({
      systemPrompt: 'AAA\n\nBBB\n\nCCC',
      tools: [tool],
      activeToolSchemaTokens: 100,
      systemSections: [
        { name: 'stableA', enabled: true, text: 'AAA', chars: 3 },
        { name: 'stableB', enabled: true, text: 'BBB', chars: 3, stability: 'stable', category: 'core' },
        { name: 'dynamicC', enabled: true, text: 'CCC', chars: 3, stability: 'dynamic', category: 'runtime' }
      ]
    })
    const second = annotateCachePrefixSnapshot(
      createCachePrefixSnapshot({
        systemPrompt: 'AAA\n\nBBB\n\nDDD',
        tools: [tool],
        activeToolSchemaTokens: 100,
        systemSections: [
          { name: 'stableA', enabled: true, text: 'AAA', chars: 3 },
          { name: 'stableB', enabled: true, text: 'BBB', chars: 3, stability: 'stable', category: 'core' },
          { name: 'dynamicC', enabled: true, text: 'DDD', chars: 3, stability: 'dynamic', category: 'runtime' }
        ]
      }),
      first
    )

    expect(second.systemSections?.map((section) => section.changed)).toEqual([
      false,
      false,
      true
    ])
    expect(second.stablePrefixRatio).toBeCloseTo(6 / 9)
    const status = renderCacheStatus({
      mode: 'auto',
      totals: new UsageTracker().totals(),
      prefix: {
        current: second,
        previous: first,
        stable: false,
        changes: 1
      },
      keepaliveIntervalMs: 300000
    })
    expect(status).toContain('dynamicC')
    expect(status).toContain('runtime')
    expect(status).toContain('Keepalive: 每 5m')
  })

  it('treats inserted prompt sections as a prefix break', () => {
    const tool = makeMockTool('probe', () => 'ok')
    const first = createCachePrefixSnapshot({
      systemPrompt: 'AAA\n\nBBB',
      tools: [tool],
      activeToolSchemaTokens: 100,
      systemSections: [
        { name: 'stableA', enabled: true, text: 'AAA', chars: 3 },
        { name: 'stableB', enabled: true, text: 'BBB', chars: 3 }
      ]
    })
    const second = annotateCachePrefixSnapshot(
      createCachePrefixSnapshot({
        systemPrompt: 'AAA\n\nXXX\n\nBBB',
        tools: [tool],
        activeToolSchemaTokens: 100,
        systemSections: [
          { name: 'stableA', enabled: true, text: 'AAA', chars: 3 },
          { name: 'insertedRuntime', enabled: true, text: 'XXX', chars: 3 },
          { name: 'stableB', enabled: true, text: 'BBB', chars: 3 }
        ]
      }),
      first
    )

    expect(second.systemSections?.map((section) => [section.name, section.changed])).toEqual([
      ['stableA', false],
      ['insertedRuntime', true],
      ['stableB', true]
    ])
    expect(second.stablePrefixRatio).toBeCloseTo(3 / 9)
  })

  it('reports changed tool schema sections', () => {
    const first = createCachePrefixSnapshot({
      systemPrompt: 'system',
      tools: [
        makeMockTool('read_file', () => 'ok'),
        makeMockTool('grep', () => 'ok')
      ],
      activeToolSchemaTokens: 100
    })
    const second = annotateCachePrefixSnapshot(
      createCachePrefixSnapshot({
        systemPrompt: 'system',
        tools: [
          makeMockTool('read_file', () => 'ok', { description: 'changed read file tool' }),
          makeMockTool('grep', () => 'ok')
        ],
        activeToolSchemaTokens: 100
      }),
      first
    )

    expect(second.toolSections?.find((section) => section.name === 'read_file')?.changed).toBe(true)
    expect(second.toolSections?.find((section) => section.name === 'grep')?.changed).toBe(false)
    const status = renderCacheStatus({
      mode: 'auto',
      totals: new UsageTracker().totals(),
      prefix: {
        current: second,
        previous: first,
        stable: false,
        changes: 1
      }
    })
    expect(status).toContain('Tools changed: read_file')
    expect(status).toContain('Tool sections:')
  })

  it('reports added and removed tool schema sections', () => {
    const first = createCachePrefixSnapshot({
      systemPrompt: 'system',
      tools: [
        makeMockTool('read_file', () => 'ok'),
        makeMockTool('grep', () => 'ok')
      ],
      activeToolSchemaTokens: 100
    })
    const second = annotateCachePrefixSnapshot(
      createCachePrefixSnapshot({
        systemPrompt: 'system',
        tools: [
          makeMockTool('read_file', () => 'ok'),
          makeMockTool('glob', () => 'ok')
        ],
        activeToolSchemaTokens: 100
      }),
      first
    )

    expect(second.toolSections?.find((section) => section.name === 'read_file')?.changed).toBe(false)
    expect(second.toolSections?.find((section) => section.name === 'glob')?.changed).toBe(true)
    expect(second.removedToolSections?.find((section) => section.name === 'grep')).toMatchObject({
      changed: true,
      removed: true
    })
    const status = renderCacheStatus({
      mode: 'auto',
      totals: new UsageTracker().totals(),
      prefix: {
        current: second,
        previous: first,
        stable: false,
        changes: 1
      }
    })
    expect(status).toContain('Tools changed: glob, grep')
    expect(status).toContain('removed')
  })

  it('does not carry removed diagnostics into the next observed snapshot', () => {
    const tracker = new CachePrefixTracker()
    const tool = makeMockTool('probe', () => 'ok')
    const first = createCachePrefixSnapshot({
      systemPrompt: 'AAA\n\nBBB',
      tools: [tool, makeMockTool('gone', () => 'ok')],
      activeToolSchemaTokens: 100,
      systemSections: [
        { name: 'stableA', enabled: true, text: 'AAA', chars: 3 },
        { name: 'removedB', enabled: true, text: 'BBB', chars: 3 }
      ]
    })
    const secondBase = createCachePrefixSnapshot({
      systemPrompt: 'AAA',
      tools: [tool],
      activeToolSchemaTokens: 50,
      systemSections: [
        { name: 'stableA', enabled: true, text: 'AAA', chars: 3 }
      ]
    })
    const second = annotateCachePrefixSnapshot(secondBase, first)
    tracker.observe(first)
    tracker.observe(second)

    expect(second.removedSystemSections?.map((section) => section.name)).toEqual(['removedB'])
    expect(second.systemSections?.map((section) => section.name)).toEqual(['stableA'])
    expect(second.removedToolSections?.map((section) => section.name)).toEqual(['gone'])
    expect(second.toolSections?.map((section) => section.name)).toEqual(['probe'])

    const third = annotateCachePrefixSnapshot(secondBase, tracker.status().current)
    expect(third.removedSystemSections).toBeUndefined()
    expect(third.removedToolSections).toBeUndefined()
    expect(third.systemSections?.map((section) => section.changed)).toEqual([false])
    expect(third.toolSections?.map((section) => section.changed)).toEqual([false])
  })

  it('renders implicit provider cache caveat when mode is off', () => {
    const tracker = new UsageTracker({ cacheMode: 'off' })
    const status = renderCacheStatus({
      mode: 'off',
      totals: tracker.totals(),
      prefix: new CachePrefixTracker().status()
    })

    expect(status).toContain('隐式 cache')
    expect(status).toContain('命中率')
    expect(status).toContain('尚未观察到模型请求')
  })
})
