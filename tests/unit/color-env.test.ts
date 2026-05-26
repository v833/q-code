import { describe, expect, it } from 'vitest'
import { applyNoColorEnvironment, type ColorEnvironment } from '../../src/runtime/color-env'

describe('color environment bootstrap', () => {
  it('maps --no-color to NO_COLOR and FORCE_COLOR=0', () => {
    const env: ColorEnvironment = {}

    applyNoColorEnvironment(['node', 'q-code', '--no-color'], env)

    expect(env.NO_COLOR).toBe('1')
    expect(env.FORCE_COLOR).toBe('0')
  })

  it('maps existing NO_COLOR to FORCE_COLOR=0 for Ink and Chalk', () => {
    const env: ColorEnvironment = { NO_COLOR: '1' }

    applyNoColorEnvironment(['node', 'q-code'], env)

    expect(env.NO_COLOR).toBe('1')
    expect(env.FORCE_COLOR).toBe('0')
  })

  it('preserves an existing NO_COLOR value', () => {
    const env: ColorEnvironment = { NO_COLOR: '' }

    applyNoColorEnvironment(['node', 'q-code', '--no-color'], env)

    expect(env.NO_COLOR).toBe('')
    expect(env.FORCE_COLOR).toBe('0')
  })
})
