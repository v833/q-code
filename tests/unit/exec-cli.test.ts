import { describe, expect, it } from 'vitest'
import { formatExecError } from '../../src/cli/exec-cli'

describe('exec CLI errors', () => {
  it('redacts configured secrets, bearer values and endpoint details', () => {
    const message = formatExecError(
      new Error(
        'request https://user:password@example.com/v1/chat?api_key=query-secret failed; '
        + 'Bearer bearer-secret; key=known-secret-value',
      ),
      { OPENAI_API_KEY: 'known-secret-value' },
    )

    expect(message).toContain('https://example.com')
    expect(message).not.toContain('password')
    expect(message).not.toContain('/v1/chat')
    expect(message).not.toContain('query-secret')
    expect(message).not.toContain('bearer-secret')
    expect(message).not.toContain('known-secret-value')
  })
})
