import { describe, expect, it } from 'vitest'
import {
  buildThemedDuckPersonaPrompt,
  DEFAULT_DUCK_PERSONA_ID,
  DUCK_PERSONA_TOGGLE_ORDER,
  formatDuckPersonaHelp,
  getDuckPersona,
  isThemedDuckPersona,
  listDuckPersonaPickerOptions,
  resolveDuckPersonaArg,
  resolveNextDuckPersona,
} from '../../src/context/duck-persona'

describe('duck-persona', () => {
  it('默认是小黄鸭，非主题鸭', () => {
    expect(DEFAULT_DUCK_PERSONA_ID).toBe('yellow')
    expect(getDuckPersona().name).toBe('小黄鸭')
    expect(isThemedDuckPersona('yellow')).toBe(false)
    expect(isThemedDuckPersona('shanghai')).toBe(true)
  })

  it('主题鸭 prompt 含方言纪律，小黄鸭无独立主题提示', () => {
    const shanghai = buildThemedDuckPersonaPrompt('shanghai')
    const heilongjiang = buildThemedDuckPersonaPrompt('heilongjiang')

    expect(shanghai).toContain('[主题鸭人格：降压鸭]')
    expect(shanghai).toContain('说话纪律')
    expect(shanghai).toContain('徐家汇地铁站大屏')
    expect(shanghai).not.toContain('你的行为准则')

    expect(heilongjiang).toContain('[主题鸭人格：屁老鸭]')
    expect(heilongjiang).toContain('扯犊子')
    expect(heilongjiang).toContain('者了')
    expect(heilongjiang).toContain('母们')
    expect(heilongjiang).toContain('雇用')
  })

  it('listDuckPersonaPickerOptions 按 toggle 顺序列出三只鸭', () => {
    const options = listDuckPersonaPickerOptions()
    expect(options.map((option) => option.id)).toEqual(['yellow', 'shanghai', 'heilongjiang'])
    expect(options[0]?.displayName).toBe('小黄鸭')
  })

  it('resolveDuckPersonaArg 支持 list、别名与 toggle', () => {
    expect(resolveDuckPersonaArg('list')).toBe('list')
    expect(resolveDuckPersonaArg('默认')).toBe('yellow')
    expect(resolveDuckPersonaArg('小黄鸭')).toBe('yellow')
    expect(resolveDuckPersonaArg('上海')).toBe('shanghai')
    expect(resolveDuckPersonaArg('降压')).toBe('shanghai')
    expect(resolveDuckPersonaArg('黑龙江')).toBe('heilongjiang')
    expect(resolveDuckPersonaArg('屁老')).toBe('heilongjiang')
    expect(resolveDuckPersonaArg('toggle')).toBe('toggle')
    expect(resolveDuckPersonaArg('unknown')).toBeUndefined()
  })

  it('resolveNextDuckPersona 按 yellow → shanghai → heilongjiang 轮换', () => {
    expect(DUCK_PERSONA_TOGGLE_ORDER).toEqual(['yellow', 'shanghai', 'heilongjiang'])
    expect(resolveNextDuckPersona('yellow', 'toggle')).toBe('shanghai')
    expect(resolveNextDuckPersona('shanghai', 'toggle')).toBe('heilongjiang')
    expect(resolveNextDuckPersona('heilongjiang', 'toggle')).toBe('yellow')
    expect(resolveNextDuckPersona('yellow', 'heilongjiang')).toBe('heilongjiang')
  })

  it('formatDuckPersonaHelp 列出小黄鸭与主题鸭', () => {
    const help = formatDuckPersonaHelp('yellow')
    expect(help).toContain('小黄鸭')
    expect(help).toContain('降压鸭')
    expect(help).toContain('屁老鸭')
    expect(help).toContain('主题鸭需主动切换')
    expect(help).toContain('/ya toggle')
  })
})
