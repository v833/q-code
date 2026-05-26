/**
 * 斜杠命令类型：解析结果、建议项与可注册命令接口。
 */

/** 用户输入解析后的斜杠命令结构。 */
export interface SlashCommandInput {
  raw: string
  name: string
  args: string
}

/** 自动补全/帮助展示用的命令摘要。 */
export interface SlashCommandSuggestion {
  name: string
  description: string
  usage?: string
  category?: string
}

/** 可注册斜杠命令：含 run 回调与可选别名。 */
export interface SlashCommand<Context> extends SlashCommandSuggestion {
  aliases?: string[]
  hidden?: boolean
  run: (input: SlashCommandInput, context: Context) => Promise<void> | void
}

/** `dispatch` 的返回：是否已处理及解析后的 input。 */
export interface SlashDispatchResult {
  handled: boolean
  command?: SlashCommandInput
}
