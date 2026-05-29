import { describe, expect, it } from 'vitest'
import {
  buildDuckCoreRules,
  DEFAULT_DUCK_PERSONA_ID,
  formatDuckPersonaHelp,
  getDuckPersona,
  resolveDuckPersonaArg,
  resolveNextDuckPersona,
} from '../../src/context/duck-persona'

describe('duck-persona', () => {
  it('默认是上海降压鸭', () => {
    expect(DEFAULT_DUCK_PERSONA_ID).toBe('shanghai')
    expect(getDuckPersona().name).toBe('降压鸭')
  })

  it('buildDuckCoreRules 按人格输出不同口头禅', () => {
    const shanghai = buildDuckCoreRules('shanghai')
    const heilongjiang = buildDuckCoreRules('heilongjiang')

    expect(shanghai).toContain('说话纪律')
    expect(shanghai).toContain('徐家汇地铁站大屏')
    expect(shanghai).toContain('Very sorry啦')
    expect(shanghai).toContain('起首第一句必须有口音')

    expect(heilongjiang).toContain('屁老鸭')
    expect(heilongjiang).toContain('扯犊子')
    expect(heilongjiang).toContain('者了')
    expect(heilongjiang).toContain('母们')
    expect(heilongjiang).toContain('雇用')
    expect(heilongjiang).toContain('主打一个实在')
    expect(shanghai).not.toContain('屁老鸭')
  })

  it('resolveDuckPersonaArg 支持别名与 toggle', () => {
    expect(resolveDuckPersonaArg('上海')).toBe('shanghai')
    expect(resolveDuckPersonaArg('降压')).toBe('shanghai')
    expect(resolveDuckPersonaArg('黑龙江')).toBe('heilongjiang')
    expect(resolveDuckPersonaArg('屁老')).toBe('heilongjiang')
    expect(resolveDuckPersonaArg('toggle')).toBe('toggle')
    expect(resolveDuckPersonaArg('unknown')).toBeUndefined()
  })

  it('resolveNextDuckPersona 在 toggle 时互换', () => {
    expect(resolveNextDuckPersona('shanghai', 'toggle')).toBe('heilongjiang')
    expect(resolveNextDuckPersona('heilongjiang', 'toggle')).toBe('shanghai')
    expect(resolveNextDuckPersona('shanghai', 'heilongjiang')).toBe('heilongjiang')
  })

  it('formatDuckPersonaHelp 列出两只鸭', () => {
    const help = formatDuckPersonaHelp('shanghai')
    expect(help).toContain('降压鸭')
    expect(help).toContain('屁老鸭')
    expect(help).toContain('/ya toggle')
  })
})
