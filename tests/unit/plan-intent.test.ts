import { describe, expect, it } from 'vitest'
import {
  classifyPendingPlanIntent,
  classifyPlanEntryIntent,
  parsePendingPlanIntentJudgeResponse,
  readPlanIntentModelTimeoutMs,
  readPlanIntentMode
} from '../../src/context/plan-intent'

describe('plan intent', () => {
  it('classifies natural language plan approval conservatively', () => {
    for (const input of ['可以', '好', '开始吧', '按这个来', '按这个方案执行', '可以执行', 'ok', 'go', 'do it']) {
      expect(classifyPendingPlanIntent(input)).toEqual({ type: 'approve' })
    }
  })

  it('does not approve negated approval-like input', () => {
    expect(classifyPendingPlanIntent('不要执行，先补充测试策略')).toEqual({
      type: 'revise',
      feedback: '不要执行，先补充测试策略'
    })
    expect(classifyPendingPlanIntent('先别开始')).toEqual({
      type: 'revise',
      feedback: '先别开始'
    })
    expect(classifyPendingPlanIntent('不可以')).toEqual({
      type: 'revise',
      feedback: '不可以'
    })
    expect(classifyPendingPlanIntent('不要执行，就按这个方案再想想')).toEqual({
      type: 'revise',
      feedback: '不要执行，就按这个方案再想想'
    })
  })

  it('does not approve casual approval-like phrases', () => {
    expect(classifyPendingPlanIntent('可以看看')).toEqual({ type: 'unknown' })
  })

  it('classifies revise, exit, cancel, and show plan intents', () => {
    expect(classifyPendingPlanIntent('补充失败回滚和测试策略')).toEqual({
      type: 'revise',
      feedback: '补充失败回滚和测试策略'
    })
    expect(classifyPendingPlanIntent('退出计划模式')).toEqual({ type: 'exit' })
    expect(classifyPendingPlanIntent('退出 plan')).toEqual({ type: 'exit' })
    expect(classifyPendingPlanIntent('退出')).toEqual({ type: 'exit' })
    expect(classifyPendingPlanIntent('取消')).toEqual({ type: 'cancel' })
    expect(classifyPendingPlanIntent('显示计划')).toEqual({ type: 'show_plan' })
  })

  it('treats negated exit and cancel phrases as revision feedback', () => {
    expect(classifyPendingPlanIntent('不要退出，继续修计划')).toEqual({
      type: 'revise',
      feedback: '不要退出，继续修计划'
    })
    expect(classifyPendingPlanIntent('不要取消，补充测试')).toEqual({
      type: 'revise',
      feedback: '不要取消，补充测试'
    })
    expect(classifyPendingPlanIntent("don't exit, revise the rollout")).toEqual({
      type: 'revise',
      feedback: "don't exit, revise the rollout"
    })
    expect(classifyPendingPlanIntent("don't cancel")).toEqual({
      type: 'revise',
      feedback: "don't cancel"
    })
  })

  it('keeps short unclear pending plan replies unknown', () => {
    expect(classifyPendingPlanIntent('嗯')).toEqual({ type: 'unknown' })
    expect(classifyPendingPlanIntent('')).toEqual({ type: 'unknown' })
  })

  it('enters plan mode for explicit analysis or planning requests', () => {
    expect(classifyPlanEntryIntent('先别改，评估一下风险')).toEqual({
      type: 'enter_plan',
      reason: '检测到明确的只读规划/分析意图'
    })
    expect(classifyPlanEntryIntent('只分析，不要修改代码')).toEqual({
      type: 'enter_plan',
      reason: '检测到明确的只读规划/分析意图'
    })
  })

  it('suggests plan mode for broad implementation requests', () => {
    expect(classifyPlanEntryIntent('完整重构 TUI 输入状态机')).toEqual({
      type: 'suggest_plan',
      reason: '任务可能涉及多文件或多阶段修改'
    })
    expect(classifyPlanEntryIntent('迁移配置体系')).toEqual({
      type: 'suggest_plan',
      reason: '任务可能涉及多文件或多阶段修改'
    })
  })

  it('stays normal for simple execution requests and slash commands', () => {
    expect(classifyPlanEntryIntent('修复这个 typo')).toEqual({ type: 'stay_normal' })
    expect(classifyPlanEntryIntent('/help')).toEqual({ type: 'stay_normal' })
  })

  it('reads plan intent mode with a safe default', () => {
    expect(readPlanIntentMode({ Q_CODE_PLAN_INTENT: 'suggest' })).toBe('suggest')
    expect(readPlanIntentMode({ Q_CODE_PLAN_INTENT: ' SUGGEST ' })).toBe('suggest')
    expect(readPlanIntentMode({ Q_CODE_PLAN_INTENT: 'off' })).toBe('off')
    expect(readPlanIntentMode({ Q_CODE_PLAN_INTENT: 'auto' })).toBe('auto')
    expect(readPlanIntentMode({ Q_CODE_PLAN_INTENT: 'weird' })).toBe('auto')
    expect(readPlanIntentMode({})).toBe('auto')
  })

  it('reads model fallback timeout with safe defaults', () => {
    expect(readPlanIntentModelTimeoutMs({ Q_CODE_PLAN_INTENT_MODEL_TIMEOUT_MS: '1500' })).toBe(1500)
    expect(readPlanIntentModelTimeoutMs({ Q_CODE_PLAN_INTENT_MODEL_TIMEOUT_MS: '0' })).toBe(0)
    expect(readPlanIntentModelTimeoutMs({ Q_CODE_PLAN_INTENT_MODEL_TIMEOUT_MS: '-1' })).toBe(3000)
    expect(readPlanIntentModelTimeoutMs({})).toBe(3000)
  })

  it('parses model judge responses with conservative approval confidence', () => {
    expect(
      parsePendingPlanIntentJudgeResponse(
        '{"intent":"approve","confidence":0.95}',
        '按第二个方案来'
      )
    ).toEqual({ type: 'approve' })
    expect(
      parsePendingPlanIntentJudgeResponse(
        '{"intent":"approve","confidence":0.7}',
        '按第二个方案来'
      )
    ).toEqual({ type: 'unknown' })
    expect(
      parsePendingPlanIntentJudgeResponse(
        '{"intent":"approve","confidence":0.99}',
        '不要执行'
      )
    ).toEqual({ type: 'unknown' })
  })

  it('parses model judge revise and low-confidence actions safely', () => {
    expect(
      parsePendingPlanIntentJudgeResponse(
        '```json\n{"intent":"revise","confidence":0.8,"feedback":"补第二套方案"}\n```',
        '补一下'
      )
    ).toEqual({ type: 'revise', feedback: '补第二套方案' })
    expect(
      parsePendingPlanIntentJudgeResponse(
        '{"intent":"exit","confidence":0.6}',
        '先退出来'
      )
    ).toEqual({ type: 'unknown' })
    expect(parsePendingPlanIntentJudgeResponse('not json', '退出')).toEqual({ type: 'unknown' })
  })
})
