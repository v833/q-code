/**
 * System prompt 管道：通过可注册的 pipe 函数按序拼接各上下文片段。
 */

/** 单次 `PromptBuilder.build` 的输入上下文。 */
export interface PromptContext {
  toolCount: number
  deferredToolSummary: string
  jitToolSummary?: string
  sessionMessageCount: number
  sessionId: string
  agentMode?: string
  taskMode?: 'task' | 'todo'
  planFilePath?: string
  taskContext?: string
  todoContext?: string
  skillsContext?: string
  agentsContext?: string
  /** 当前可见工具集中是否包含 `Agent`，用于避免向无此工具的子 Agent 注入委派建议。 */
  canDelegateToAgents?: boolean
  teamsContext?: string
  runtimeContext?: string
  agentMdContext?: string
  memoryContext?: string
}

type PipeFn = (ctx: PromptContext) => string | null

/** 按注册顺序执行 pipe，将非 null 结果以双换行拼接为 system prompt。 */
export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = []

  /**
   * 注册一个命名 pipe。
   * @param name 调试输出用名称
   * @param fn 返回 null 表示跳过该段
   */
  pipe(name: string, fn: PipeFn): this {
    this.pipes.push({ name, fn })
    return this
  }

  /** 执行全部 pipe 并拼接为最终 system prompt 字符串。 */
  build(ctx: PromptContext): string {
    const sections: string[] = []

    for (const { fn } of this.pipes) {
      const result = fn(ctx)
      if (result !== null) {
        sections.push(result)
      }
    }

    return sections.join('\n\n')
  }

  /** 打印每个 pipe 的 ON/OFF 与字符数，便于调试 prompt 组成。 */
  debug(ctx: PromptContext, log: (text: string) => void = console.log): void {
    log('\n=== Prompt Pipe Debug ===')
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx)
      const status = result !== null ? `[ON] ${result.length} chars` : '[OFF]'
      log(`  ${name}: ${status}`)
    }
    log('========================\n')
  }
}

/** 核心行为准则 pipe。 */
export function coreRules(): PipeFn {
  return () => `你是 q-code，一个有工具调用能力的 AI 助手。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 执行需要多次工具调用的任务时，在关键工具调用前后输出简短、可公开的进度说明：说明你正在看什么、为什么看、刚确认了什么。每次 1-2 句即可，不要暴露隐藏推理链或内部草稿
- 回答要简洁直接`
}

/** 工具使用与 JIT 上下文纪律 pipe；无工具时返回 null。 */
export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null
    return [
      `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`,
      '',
      '[JIT Context Discipline]',
      '- 上下文应在需要时进入，不要在一开始批量读取可能无关的大文件、网页或长命令输出。',
      '- 代码/文件探索优先使用低成本到高成本阶梯：list_directory/glob → grep → read_file 的精确行段。',
      ctx.canDelegateToAgents
        ? '- 只把能推进当前判断的最小证据放进主上下文；宽搜索、噪音探索或可并行调查优先交给 Agent/Explore。'
        : '- 只把能推进当前判断的最小证据放进当前上下文；不要调用当前工具列表中不存在的委派工具。',
      '- Skill、SubAgent、MCP 工具都遵循渐进式披露：先看名称/摘要/Schema，必要时再加载正文或执行高成本工具。',
      ctx.jitToolSummary ? ['', '当前工具成本阶梯：', ctx.jitToolSummary].join('\n') : null
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  }
}

/** 延迟加载工具与 tool_search 提示 pipe。 */
export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null
    return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`
  }
}

/** 注入 Skills 上下文 pipe。 */
export function skillsContext(): PipeFn {
  return (ctx) => {
    if (!ctx.skillsContext) return null
    return ctx.skillsContext
  }
}

/** 注入 SubAgent 说明 pipe。 */
export function agentsContext(): PipeFn {
  return (ctx) => {
    if (!ctx.agentsContext) return null
    return ctx.agentsContext
  }
}

/** 注入 Agent Teams 说明 pipe。 */
export function teamsContext(): PipeFn {
  return (ctx) => {
    if (!ctx.teamsContext) return null
    return ctx.teamsContext
  }
}

/** Todo 模式下的 todo_write 使用指引 pipe。 */
export function todoGuide(): PipeFn {
  return (ctx) => {
    if (ctx.taskMode !== 'todo') return null
    return [
      '多步骤任务请主动使用 todo_write 维护会话级任务清单。',
      '任务清单应保持简短、可执行；每次调用 todo_write 都要传入完整列表。',
      '通常保持恰好一个任务为 in_progress；完成全部任务后把所有项标记 completed，让清单自动清空。'
    ].join('\n')
  }
}

/** 注入当前会话 Todo 列表 pipe。 */
export function todoContext(): PipeFn {
  return (ctx) => {
    if (ctx.taskMode !== 'todo') return null
    if (!ctx.todoContext) return null
    return ['当前会话任务清单：', ctx.todoContext].join('\n\n')
  }
}

/** Task 模式下的 task_* 工具使用指引 pipe。 */
export function taskGuide(): PipeFn {
  return (ctx) => {
    if (ctx.taskMode !== 'task') return null
    return [
      '复杂、多步骤或跨回合任务请优先使用 task_create / task_update / task_get / task_list 维护持久化任务图。',
      '开始执行前先用 task_list 找到 ready 的任务；更新任务前先用 task_get 读取最新状态。',
      '用 blockedBy / blocks 表达依赖关系。完成一个任务后标记 completed，再调用 task_list 查看被解锁的后续任务。',
      '短小临时任务如确实只需要会话便签，用户可通过 /tasks todo 切回 TodoWrite V1。'
    ].join('\n')
  }
}

/** 注入当前持久化任务图 pipe。 */
export function taskContext(): PipeFn {
  return (ctx) => {
    if (ctx.taskMode !== 'task') return null
    if (!ctx.taskContext) return null
    return ['当前持久化任务图：', ctx.taskContext].join('\n\n')
  }
}

/** Plan Mode 运行模式说明 pipe。 */
export function modeContext(): PipeFn {
  return (ctx) => {
    if (ctx.agentMode !== 'plan') return null
    return [
      '[运行模式] 当前为 Plan Mode。',
      '只进行只读探索、任务清单更新和计划编写，不要修改项目文件或运行会改变环境的命令。',
      ctx.planFilePath ? `计划文件: ${ctx.planFilePath}` : null
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  }
}

/** 注入运行环境（cwd/OS/Git）pipe。 */
export function runtimeEnvironment(): PipeFn {
  return (ctx) => {
    if (!ctx.runtimeContext) return null
    return ctx.runtimeContext
  }
}

/** 注入 AGENT.md / AGENTS.md 项目指令 pipe。 */
export function agentMdInstructions(): PipeFn {
  return (ctx) => {
    if (!ctx.agentMdContext) return null
    return [
      '项目指令（AGENT.md / AGENTS.md）：',
      '以下内容按从全局到项目根、再到当前目录的顺序加载；发生冲突时，后出现、路径更接近当前工作目录的指令优先。',
      ctx.agentMdContext
    ].join('\n\n')
  }
}

/** 注入项目记忆 system 上下文 pipe。 */
export function projectMemory(): PipeFn {
  return (ctx) => {
    if (!ctx.memoryContext) return null
    return ['项目记忆（文件级跨对话记忆）：', ctx.memoryContext].join('\n\n')
  }
}

/** 注入会话 ID 与历史消息数 pipe。 */
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null
    return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`
  }
}
