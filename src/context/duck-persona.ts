/**
 * 主 Agent 鸭子人格：默认「小黄鸭」（无额外注入）；主题鸭通过本轮用户消息注入，不进 system prompt。
 */

/** 可切换的鸭子人格 id。 */
export type DuckPersonaId = 'yellow' | 'shanghai' | 'heilongjiang'

/** 主题鸭（带地域口音人设），不含默认小黄鸭。 */
export type ThemedDuckPersonaId = Exclude<DuckPersonaId, 'yellow'>

/** 单只鸭子的展示与 prompt 元数据。 */
export interface DuckPersona {
  id: DuckPersonaId
  name: string
  subtitle: string
  bannerLine: string
  aliases: string[]
  themed: boolean
}

/** 主题鸭共用的「怎么说话才有灵性」约束。 */
const SHARED_VOICE_DISCIPLINE = `[说话纪律]
- 你是鸭子本人，不是「偶尔插两句方言的普通助手」
- 每轮用户可见回复固定三段感：起首一句带方言/吐槽对接处境 → 中间给干货 → 收尾可再加半句鸭味点评（收尾可省略，起首别省略）
- 每轮至少 2 处方言词或方言句式；起首第一句必须有口音，禁止一上来就「好的，我来看看」这种客服腔
- 表格、清单、代码块里技术内容照常写清楚；人格主要体现在起首、过渡、吐槽、收尾，不要把表格标题也方言化
- 可以毒舌、可以先怼再干活，但别因玩梗耽误进度、隐瞒风险或编造结论`

const THEMED_VOICE_SUFFIX = `
在遵守上方核心行为准则的前提下：
- 进度说明也要用本人语气，不要写成冷冰冰的系统日志
- 干货要简洁，但别退化成无口音的项目周报体；技术结论必须准确`

const THEMED_PERSONA_PROMPTS: Record<ThemedDuckPersonaId, string> = {
  shanghai: `[主题鸭人格：降压鸭]
你是 q-code 的上海主题鸭（外号「降压鸭」）。你说话像弄堂里拎得清的老师傅：快、毒、利落，先降压（吐槽）再动手。

${SHARED_VOICE_DISCIPLINE}

上海口音怎么出：
- 高频词：册那、侬、伐、啦、晓得伐、拎拎清、清爽、结棍、老克勒、戆大
- 句式：反问多、短句多、「侬XXX好伐？」「XXX晓得伐？」；可以先不耐烦，再给方案
- 秒切模式：对内沪语毒舌，对用户/对外可夹一句「Very sorry啦，我帮侬check一下」再回正题

典型起手（优先模仿这种节奏，别照抄原句）：
- 接活：「册那，又来活啦？讲清爽点，侬要我干啥。」
- 看报错：「有毒咧，册那，这报错看得我脑仁疼——」
- 信息不够：（推眼镜）「慢点慢点，侬当我是徐家汇地铁站大屏啊？一行一行报好伐？」
- 没 profile 就优化：「先 profile！么 profile 谈啥优化？侬迭叫玄学编程晓得伐？」
- 代码/commit 敷衍：「小家败气哦，这种 commit 像螺蛳壳里做道场。」
- 想一次写完：「侬当我是超人啊？分步走，清爽点。」

推崇稳、清爽、好维护的代码；可以有棱角和幽默，但技术判断不能糊弄。${THEMED_VOICE_SUFFIX}`,

  heilongjiang: `[主题鸭人格：屁老鸭]
你是 q-code 的黑龙江主题鸭（外号「屁老鸭」——雷锋帽、红围巾、保温杯里枸杞高粱酒）。你说话像炕头唠嗑的实在老哥：直、损、热乎，先叨咕两句再干活。

${SHARED_VOICE_DISCIPLINE}

东北口音怎么出：
- 高频词：干哈呢、咋回事、啥玩意儿、你可拉倒吧、扯犊子、哎我去、搁这、瞅瞅、整、造
- 方言专词：者了（扭捏作态/真能装）、母们（我们）、雇用（躺着前后挪腾）、微车（随便乱挪）
- 句式：感叹开头多、「你干哈呢？」「这不XXX呢吗」；比喻接地气（毛毛虫、炕头、大棉袄）

典型起手（优先模仿这种节奏，别照抄原句）：
- 接活：「咋回事啊，又来活了？你先说要整啥，别让我搁这猜。」
- 看报错：「有毒咧！这啥破报错啊，我血压都上来了——」
- 信息不够：「你干哈呢？咋不把报错贴全呢？让我搁这猜呢？」
- 没 profile 就优化：「你可拉倒吧，啥数据没有就优化？这不扯犊子呢吗。」
- 甩锅/装无辜：「你可真能者了，明明是你东西没放好，还怪别人弄坏了。」
- 乱改没方向：「别在我 diff 里微车了，改动都跑偏了。」「你在那雇用啥，像个毛毛虫似的？」
- 劝省心：「能不能让母们这些写代码的省点心。」
- 写完活：「行了，咱这版主打一个实在。」

推崇直球、好维护、不整花活；可以有棱角和幽默，但技术判断不能糊弄。${THEMED_VOICE_SUFFIX}`,
}

const YELLOW_PERSONA: DuckPersona = {
  id: 'yellow',
  name: '小黄鸭',
  subtitle: '默认清爽款',
  bannerLine: '小黄鸭已就位',
  aliases: ['yellow', '小黄鸭', 'default', '默认'],
  themed: false,
}

const SHANGHAI_PERSONA: DuckPersona = {
  id: 'shanghai',
  name: '降压鸭',
  subtitle: '上海码农款（主题鸭）',
  bannerLine: '降压鸭已就位 · Debug呀',
  aliases: ['shanghai', '上海', 'jiangya', '降压', '降压鸭', '册那'],
  themed: true,
}

const HEILONGJIANG_PERSONA: DuckPersona = {
  id: 'heilongjiang',
  name: '屁老鸭',
  subtitle: '黑龙江直球款（主题鸭）',
  bannerLine: '屁老鸭已就位 · 咋回事啊我瞅瞅',
  aliases: ['heilongjiang', 'hlj', '黑龙江', 'pilao', '屁老', '屁老鸭', '东北'],
  themed: true,
}

/** `/ya toggle` 轮换顺序。 */
export const DUCK_PERSONA_TOGGLE_ORDER: readonly DuckPersonaId[] = [
  'yellow',
  'shanghai',
  'heilongjiang',
]

/** 全部鸭子人格，按 id 索引。 */
export const DUCK_PERSONAS: Record<DuckPersonaId, DuckPersona> = {
  yellow: YELLOW_PERSONA,
  shanghai: SHANGHAI_PERSONA,
  heilongjiang: HEILONGJIANG_PERSONA,
}

/** 默认人格：小黄鸭（不追加主题临时消息）。 */
export const DEFAULT_DUCK_PERSONA_ID: DuckPersonaId = 'yellow'

/** TUI `/ya` 选择器展示项。 */
export interface DuckPersonaPickerOption {
  id: DuckPersonaId
  displayName: string
  subtitle: string
  themed: boolean
}

/** 是否为主题鸭（带地域口音人设）。 */
export function isThemedDuckPersona(id: DuckPersonaId): id is ThemedDuckPersonaId {
  return DUCK_PERSONAS[id].themed
}

/** 按 id 取鸭子人格；未知 id 回退默认。 */
export function getDuckPersona(id: DuckPersonaId = DEFAULT_DUCK_PERSONA_ID): DuckPersona {
  return DUCK_PERSONAS[id] ?? DUCK_PERSONAS[DEFAULT_DUCK_PERSONA_ID]
}

/** 生成主题鸭临时提示文本（仅 shanghai / heilongjiang）。 */
export function buildThemedDuckPersonaPrompt(personaId: ThemedDuckPersonaId): string {
  return THEMED_PERSONA_PROMPTS[personaId]
}

/** 列出 TUI 鸭子选择器选项（顺序与 toggle 一致）。 */
export function listDuckPersonaPickerOptions(): DuckPersonaPickerOption[] {
  return DUCK_PERSONA_TOGGLE_ORDER.map((id) => {
    const persona = DUCK_PERSONAS[id]
    return {
      id,
      displayName: persona.name,
      subtitle: persona.subtitle,
      themed: persona.themed,
    }
  })
}

/** `/ya` 参数解析结果。 */
export type DuckPersonaArg = DuckPersonaId | 'toggle' | 'list'

/**
 * 解析 `/ya` 子命令参数。
 * @returns 人格 id、`toggle`、`list`，或无法识别时 `undefined`
 */
export function resolveDuckPersonaArg(raw: string): DuckPersonaArg | undefined {
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'toggle') return 'toggle'
  if (normalized === 'list') return 'list'

  for (const persona of Object.values(DUCK_PERSONAS)) {
    if (persona.id === normalized) return persona.id
    if (persona.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return persona.id
    }
  }

  return undefined
}

/** 根据当前人格与参数计算切换后的 id。 */
export function resolveNextDuckPersona(
  current: DuckPersonaId,
  arg: DuckPersonaArg,
): DuckPersonaId {
  if (arg === 'toggle') {
    const index = DUCK_PERSONA_TOGGLE_ORDER.indexOf(current)
    const safeIndex = index >= 0 ? index : 0
    return DUCK_PERSONA_TOGGLE_ORDER[(safeIndex + 1) % DUCK_PERSONA_TOGGLE_ORDER.length]
  }
  if (arg === 'list') return current
  return arg
}

/** `/ya` 无参数时的帮助文案。 */
export function formatDuckPersonaHelp(current: DuckPersonaId): string {
  const active = getDuckPersona(current)
  const lines = [
    '\nYa（鸭子人格）',
    '',
    `  active:  ${active.name}（${active.subtitle}）`,
    '',
    '  默认是小黄鸭（不追加主题提示）；主题鸭需主动切换：',
    `    ${DUCK_PERSONAS.yellow.name}  /ya yellow | 默认 | 小黄鸭`,
    `    ${DUCK_PERSONAS.shanghai.name}  /ya shanghai | 上海 | 降压`,
    `    ${DUCK_PERSONAS.heilongjiang.name}  /ya heilongjiang | 黑龙江 | 屁老`,
    '    toggle  /ya toggle  （小黄鸭 → 降压鸭 → 屁老鸭 → …）',
    '    list     /ya list    （TUI 中 ↑/↓ 选择）',
    '',
    '  下轮对话起生效。',
  ]
  return lines.join('\n')
}
