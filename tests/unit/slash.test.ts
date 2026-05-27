import { describe, expect, it, vi } from 'vitest'
import {
  createSlashCommandRegistry,
  filterSlashCommandSuggestions,
  parseSlashCommand
} from '../../src/slash'

describe('slash command parser', () => {
  it('parses command name and trailing args', () => {
    expect(parseSlashCommand('/model gpt-5.2')).toEqual({
      raw: '/model gpt-5.2',
      name: 'model',
      args: 'gpt-5.2'
    })
  })

  it('ignores non slash input and malformed names', () => {
    expect(parseSlashCommand('hello')).toBeNull()
    expect(parseSlashCommand('/bad.name')).toBeNull()
  })
})

describe('slash command registry', () => {
  it('dispatches by command name and aliases', async () => {
    const run = vi.fn()
    const registry = createSlashCommandRegistry([
      {
        name: '/exit',
        aliases: ['/quit', 'bye'],
        description: 'Exit',
        run
      }
    ])

    await expect(registry.dispatch('/quit now', {})).resolves.toMatchObject({ handled: true })
    expect(run).toHaveBeenCalledWith(
      { raw: '/quit now', name: 'quit', args: 'now' },
      {}
    )
  })

  it('returns unhandled parsed input for unknown commands', async () => {
    const registry = createSlashCommandRegistry()
    await expect(registry.dispatch('/missing arg', {})).resolves.toEqual({
      handled: false,
      input: { raw: '/missing arg', name: 'missing', args: 'arg' }
    })
  })

  it('formats help from non-hidden command metadata', () => {
    const registry = createSlashCommandRegistry([
      {
        name: '/help',
        description: 'Show commands',
        usage: '/help',
        category: 'Core',
        run: () => undefined
      },
      {
        name: '/secret',
        description: 'Hidden',
        hidden: true,
        run: () => undefined
      }
    ])

    const help = registry.formatHelp()
    expect(help).toContain('/help')
    expect(help).toContain('Show commands')
    expect(help).not.toContain('/secret')
  })
})

describe('slash command suggestions', () => {
  const commands = [
    { name: '/help', description: 'Show commands' },
    { name: '/history', description: 'Show sessions' },
    { name: '/sessions', description: 'Manage sessions' },
    { name: '/model', description: 'Switch model' },
    { name: '/hello', description: 'Skill hello' }
  ]

  it('filters suggestions by slash prefix in registration order', () => {
    expect(filterSlashCommandSuggestions('/h', commands).map((item) => item.name)).toEqual([
      '/help',
      '/history',
      '/hello'
    ])
  })

  it('finds the sessions command by prefix', () => {
    expect(filterSlashCommandSuggestions('/sess', commands).map((item) => item.name)).toEqual([
      '/sessions'
    ])
  })

  it('deduplicates command names and limits result count', () => {
    expect(
      filterSlashCommandSuggestions(
        '/',
        [
          { name: '/help', description: 'Show commands' },
          { name: '/help', description: 'Duplicate' },
          { name: '/history', description: 'Show sessions' }
        ],
        1
      )
    ).toEqual([{ name: '/help', description: 'Show commands' }])
  })
})
