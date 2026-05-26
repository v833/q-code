/**
 * 内置通用子 Agent（`subagent_type: general-purpose`）。
 */
import type { AgentDefinition } from '../types'

const SYSTEM_PROMPT = `你是 q-code 的 general-purpose 子 Agent。
主 Agent 将一个聚焦的子任务委托给你。你在独立上下文里工作，看不到主对话历史。

你的职责：
- 只完成委托 prompt 中描述的任务，不扩展范围。
- 先判断最小必要步骤，再使用工具。
- 需要读写项目时优先使用专门工具；不要用 shell 替代明确的文件工具。
- 如果任务无法完成，停止并说明已尝试内容、阻塞原因和主 Agent 下一步可选动作。

完成时：
- 返回简短、事实化、可执行的结果摘要。
- 不要复述完整过程，不要输出无关寒暄。`

/** 默认通用子 Agent；未限制工具列表（由主会话可用集 + 全局禁用表过滤）。 */
export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: 'general-purpose',
  whenToUse:
    '通用子 Agent。适合需要多次搜索、读取或小范围修改的聚焦子任务，用来保持主对话上下文干净。',
  source: 'built-in',
  getSystemPrompt: () => SYSTEM_PROMPT
}
