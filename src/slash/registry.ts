/**
 * 斜杠命令注册表：注册、别名解析、帮助格式化与 dispatch。
 */
import { parseSlashCommand } from './parser'
import type { SlashCommand, SlashCommandInput, SlashCommandSuggestion } from './types'

/** 管理内置与用户斜杠命令的注册与分发。 */
export class SlashCommandRegistry<Context> {
  private readonly commands = new Map<string, SlashCommand<Context>>()
  private readonly aliases = new Map<string, string>()

  register(...commands: SlashCommand<Context>[]): void {
    for (const command of commands) {
      const name = normalizeName(command.name)
      this.commands.set(name, { ...command, name: `/${name}` })
      for (const alias of command.aliases ?? []) {
        this.aliases.set(normalizeName(alias), name)
      }
    }
  }

  resolve(name: string): SlashCommand<Context> | undefined {
    const normalized = normalizeName(name)
    return this.commands.get(this.aliases.get(normalized) ?? normalized)
  }

  getSuggestions(): SlashCommandSuggestion[] {
    return [...this.commands.values()]
      .filter((command) => !command.hidden)
      .map(({ name, description, usage, category }) => ({ name, description, usage, category }))
  }

  formatHelp(): string {
    const groups = new Map<string, SlashCommandSuggestion[]>()
    for (const command of this.getSuggestions()) {
      const category = command.category ?? 'Other'
      groups.set(category, [...(groups.get(category) ?? []), command])
    }

    const lines = ['Slash commands', '']
    for (const [category, commands] of groups) {
      lines.push(`${category}:`)
      for (const command of commands) {
        const usage = command.usage ?? command.name
        lines.push(`  ${usage.padEnd(24)} ${command.description}`)
      }
      lines.push('')
    }
    lines.push('Skills: /<skill-name> [args]')
    return lines.join('\n').trimEnd()
  }

  async dispatch(rawInput: string, context: Context): Promise<{ handled: boolean; input?: SlashCommandInput }> {
    const input = parseSlashCommand(rawInput)
    if (!input) return { handled: false }

    const command = this.resolve(input.name)
    if (!command) return { handled: false, input }

    await command.run(input, context)
    return { handled: true, input }
  }
}

/** 创建并预注册一批斜杠命令的便捷工厂。 */
export function createSlashCommandRegistry<Context>(
  commands: SlashCommand<Context>[] = []
): SlashCommandRegistry<Context> {
  const registry = new SlashCommandRegistry<Context>()
  registry.register(...commands)
  return registry
}

function normalizeName(value: string): string {
  return value.replace(/^\//, '').trim().toLowerCase()
}
