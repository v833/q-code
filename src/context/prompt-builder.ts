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

export type PipeFn = (ctx: PromptContext) => string | null

/** Prompt pipe 的稳定性分层，用于 cache 前缀治理与诊断。 */
export type PromptStability = 'stable' | 'session-stable' | 'dynamic'

/** Prompt pipe 的功能类别，用于 `/cache status` 分组排查。 */
export type PromptSectionCategory =
  | 'core'
  | 'project'
  | 'tools'
  | 'skills'
  | 'agents'
  | 'mode'
  | 'task'
  | 'todo'
  | 'runtime'
  | 'memory'
  | 'session'
  | 'other'

/** Prompt pipe 的注册元数据。 */
export interface PromptPipeMeta {
  name: string
  stability?: PromptStability
  category?: PromptSectionCategory
  cacheCritical?: boolean
}

/** 共享稳定 prompt pipe 的插入点配置。 */
export interface SharedStablePromptPipeOptions {
  afterProjectInstructions?: Array<{ meta: PromptPipeMeta; fn: PipeFn }>
  includeAgentsContext?: boolean
}

/** 单个 prompt pipe 的渲染诊断信息。 */
export interface PromptSectionInspection {
  name: string
  enabled: boolean
  text: string
  chars: number
  stability: PromptStability
  category: PromptSectionCategory
  cacheCritical: boolean
}

/** 按注册顺序执行 pipe，将非 null 结果以双换行拼接为 system prompt。 */
export class PromptBuilder {
  private pipes: Array<{ meta: Required<PromptPipeMeta>; fn: PipeFn }> = []

  /**
   * 注册一个命名 pipe。
   * @param name 调试输出用名称
   * @param fn 返回 null 表示跳过该段
   */
  pipe(nameOrMeta: string | PromptPipeMeta, fn: PipeFn): this {
    const meta = normalizePipeMeta(nameOrMeta)
    this.pipes.push({ meta, fn })
    return this
  }

  /** 执行全部 pipe 并拼接为最终 system prompt 字符串。 */
  build(ctx: PromptContext): string {
    return this.inspect(ctx)
      .filter((section) => section.enabled)
      .map((section) => section.text)
      .join('\n\n')
  }

  /** 渲染各 pipe 并返回分段结果，供 cache 诊断定位变化来源。 */
  inspect(ctx: PromptContext): PromptSectionInspection[] {
    const sections: PromptSectionInspection[] = []

    for (const { meta, fn } of this.pipes) {
      const result = fn(ctx)
      const enabled = result !== null
      sections.push({
        name: meta.name,
        enabled,
        text: result ?? '',
        chars: result?.length ?? 0,
        stability: meta.stability,
        category: meta.category,
        cacheCritical: meta.cacheCritical
      })
    }

    return sections
  }

  /** 打印每个 pipe 的 ON/OFF 与字符数，便于调试 prompt 组成。 */
  debug(ctx: PromptContext, log: (text: string) => void = console.log): void {
    log('\n=== Prompt Pipe Debug ===')
    for (const { meta, fn } of this.pipes) {
      const result = fn(ctx)
      const status = result !== null ? `[ON] ${result.length} chars` : '[OFF]'
      log(`  ${meta.name}: ${status}`)
    }
    log('========================\n')
  }
}

/** 创建主 CLI 的稳定 system prompt 管道；CLI 与 cache 验证脚本共用，避免实现漂移。 */
export function createSystemPromptBuilder(): PromptBuilder {
  return createSharedStablePromptBuilder()
}

/** 创建主 Agent / SubAgent 共用的稳定 system prompt 管道。 */
export function createSharedStablePromptBuilder(
  options: SharedStablePromptPipeOptions = {}
): PromptBuilder {
  return addSharedStablePromptPipes(new PromptBuilder(), options)
}

/** 向指定 builder 追加共享稳定 prompt pipe，允许在项目指令后插入角色专属说明。 */
export function addSharedStablePromptPipes(
  builder: PromptBuilder,
  options: SharedStablePromptPipeOptions = {}
): PromptBuilder {
  const includeAgentsContext = options.includeAgentsContext ?? true

  builder
    .pipe({ name: 'coreRules', stability: 'stable', category: 'core', cacheCritical: true }, coreRules())
    .pipe({ name: 'agentMdInstructions', stability: 'stable', category: 'project', cacheCritical: true }, agentMdInstructions())

  for (const pipe of options.afterProjectInstructions ?? []) {
    builder.pipe(pipe.meta, pipe.fn)
  }

  builder
    .pipe({ name: 'toolDiscipline', stability: 'stable', category: 'tools', cacheCritical: true }, toolDiscipline())
    .pipe({ name: 'behaviorExamples', stability: 'stable', category: 'core', cacheCritical: true }, behaviorExamples())
    .pipe({ name: 'skillDiscipline', stability: 'stable', category: 'skills', cacheCritical: true }, skillDiscipline())

  if (includeAgentsContext) {
    builder.pipe({ name: 'agentsContext', stability: 'stable', category: 'agents', cacheCritical: true }, agentsContext())
  }

  builder.pipe({ name: 'deferredToolDiscipline', stability: 'stable', category: 'tools' }, () => '若当前工具列表中存在 `tool_search`，并且你需要的工具不在当前列表中，使用 `tool_search` 搜索。')

  return builder
}

function normalizePipeMeta(nameOrMeta: string | PromptPipeMeta): Required<PromptPipeMeta> {
  if (typeof nameOrMeta === 'string') {
    return {
      name: nameOrMeta,
      stability: 'dynamic',
      category: 'other',
      cacheCritical: false
    }
  }

  return {
    name: nameOrMeta.name,
    stability: nameOrMeta.stability ?? 'dynamic',
    category: nameOrMeta.category ?? 'other',
    cacheCritical: nameOrMeta.cacheCritical ?? false
  }
}

/** 核心行为准则 pipe（稳定前缀，便于 provider cache 命中）。 */
export function coreRules(): PipeFn {
  return () => `你是 q-code，一个有工具调用能力的 AI 助手。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 最终回答默认使用 Markdown，说明改了什么、验证了什么和仍有什么风险
- 工具调用失败时，换一个思路而不是重复同样的操作
- 执行需要多次工具调用的任务时，在关键工具调用前后输出简短、可公开的进度说明：说明你正在看什么、为什么看、刚确认了什么。每次 1-2 句即可，不要暴露隐藏推理链或内部草稿
- 复杂任务先计划再执行；验证不通过不得声明完成
- 回答要简洁直接`
}

/** 稳定工具使用纪律 pipe；不包含工具数量、JIT 摘要等高频动态字段。 */
export function toolDiscipline(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null
    return [
      '[JIT Context Discipline]',
      '- 上下文应在需要时进入，不要在一开始批量读取可能无关的大文件、网页或长命令输出。',
      '- 代码/文件探索优先使用低成本到高成本阶梯：list_directory/glob → grep → read_file 的精确行段。',
      '- 只把能推进当前判断的最小证据放进当前上下文；不要调用当前工具列表中不存在的委派工具。',
      '- 会改动同一工作区状态的工具调用应保持串行，避免并发写入造成不可预期结果。',
      '- Skill、SubAgent、MCP 工具都遵循渐进式披露：先看名称/摘要/Schema，必要时再加载正文或执行高成本工具。',
      '- 使用 f 执行 shell 命令时先看运行环境：Windows 下 command 已在 PowerShell 中运行，macOS/Linux 下 command 已在 Bash 中运行；直接写当前系统的原生 shell 命令，不要再套同类 shell，也不要混用其他平台方言。',
    ]
      .join('\n')
  }
}

/** 动态工具运行摘要 pipe；放在稳定前缀之后，避免工具集变化切断大块 cache。 */
export function toolRuntimeSummary(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null
    return [
      `当前有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`,
      ctx.canDelegateToAgents
        ? '当前可使用 Agent/Explore；宽搜索、噪音探索或可并行调查优先委派，主上下文只接收摘要。'
        : '当前不可使用委派工具；不要假设或调用不可见的委派能力。',
      ctx.jitToolSummary ? ['', '当前工具成本阶梯：', ctx.jitToolSummary].join('\n') : null
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  }
}

/** 兼容旧调用点的组合工具提示；新 system prompt 管道应拆开注册稳定/动态段。 */
export function toolGuide(): PipeFn {
  return (ctx) => {
    const sections = [toolDiscipline()(ctx), toolRuntimeSummary()(ctx)]
      .filter((section): section is string => Boolean(section))
    return sections.length > 0 ? sections.join('\n\n') : null
  }
}

/** 少量稳定正反例，用来钉住工具选择、沟通、失败恢复与交付输出边界。 */
export function behaviorExamples(): PipeFn {
  return () => [
    '[Behavior Examples / 行为示例]',
    '- Good: 需要定位代码时，先 grep/list_directory 缩小范围，再 read_file 精确行段；BAD: 一开始批量读取大量文件。',
    '- Good: 缺少关键决策、权限确认或设计偏好时再问用户，并用一句话澄清；BAD: 能通过工具先探索的问题直接追问。',
    '- Good: 多步骤任务保持恰好一个 in_progress，完成后再标 completed；BAD: 未执行就提前标记完成。',
    '- Good: 遇到密钥、越权或危险请求时明确拒绝，并给出安全替代方案；BAD: 解释如何绕过权限或泄露敏感信息。',
    '- Good: 项目记忆正文只通过 transient context 按需注入，用户说忽略记忆时不读取或注入 MEMORY.md 详情；BAD: 把记忆内容当作本轮必须遵循的新需求。',
    '- Good: 工具或测试失败时，先看错误，核实参数，换路尝试，按需运行 typecheck，仍失败再求助；BAD: 反复重试同一命令或修改测试掩盖问题。',
    '- Good: 最终回答说明改了什么、验证了什么、仍有什么风险；BAD: 验证不通过不得声明完成，也不要输出冗长无关解释。',
    '- Good: 行为示例应作为正反例锚点，前端或文档质量使用最多/禁用这类可执行约束；BAD: 只写“更好看、更高级”这类主观目标。'
  ].join('\n')
}

/** 延迟加载工具与 tool_search 提示 pipe。 */
export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null
    return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`
  }
}

/** 稳定 Skill 使用纪律 pipe；当前 Skill 列表由 transient context 承载。 */
export function skillDiscipline(): PipeFn {
  return () => [
    '若当前工具列表中存在 `Skill` 工具，本轮运行上下文会列出当前模型可见 Skills。',
    '当用户请求匹配某个已列出 Skill 的描述或适用场景时，优先调用 `Skill(skill="<name>", args="<optional args>")` 获取完整工作流。',
    '不要猜测未列出的 Skill，也不要把 Skill 正文预加载进上下文。'
  ].join('\n')
}

/** 注入当前可见 Skills 列表 pipe。 */
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

/** 注入稳定会话标识 pipe。 */
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (!ctx.sessionId) return null
    return `[会话信息] 当前会话 ${ctx.sessionId}。`
  }
}
