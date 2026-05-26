/**
 * 项目记忆类型定义与 system prompt 中的记忆使用指引文案。
 */

/** 支持的记忆 frontmatter 类型枚举。 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

/** 单条记忆的分类。 */
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** Markdown 记忆文件 frontmatter 必填字段。 */
export interface MemoryFrontmatter {
  name: string
  description: string
  type: MemoryType
}

/** `MEMORY.md` 索引中的一条记忆条目元数据。 */
export interface MemoryEntry {
  fileName: string
  filePath: string
  title: string
  hook: string
}

/** 判断字符串是否为合法 `MemoryType`。 */
export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && MEMORY_TYPES.includes(value as MemoryType)
}

/** 生成「记忆类型」说明段落（用于 system prompt）。 */
export function buildMemoryTypeGuidance(): string[] {
  return [
    '## 记忆类型',
    '',
    '你可以保存四类长期项目记忆：',
    '',
    '- user: 用户长期偏好、协作方式、目标或角色信息。',
    '- feedback: 用户对执行方式、质量标准、注意事项的长期反馈。',
    '- project: 不能直接从当前仓库稳定推导出的项目约束、背景、负责人、时间点或决策。',
    '- reference: 外部系统、仪表盘、文档、工单或数据源的位置。'
  ]
}

/** 生成「何时访问记忆」说明段落。 */
export function buildMemoryAccessGuidance(): string[] {
  return [
    '## 何时访问记忆',
    '- 当用户提到以前的约定、历史偏好、项目背景，或当前任务看起来与 MEMORY.md 索引相关时，应主动读取相关记忆文件。',
    '- MEMORY.md 只是索引；如果某条索引相关，先用 read_file 读取对应记忆文件，再基于内容行动。',
    '- 当用户明确说“记住”“以后记得”“查一下记忆”“回忆一下”时，必须考虑项目记忆。',
    '- 如果用户要求忽略记忆，本轮不要应用、引用或比较任何已保存记忆。'
  ]
}

/** 生成「使用记忆前校验」说明段落。 */
export function buildMemoryValidationGuidance(): string[] {
  return [
    '## 使用记忆前的校验',
    '- 项目记忆只表示写入时确认过的长期信息，不等于当前事实。',
    '- 如果记忆提到文件路径、函数、配置、命令或外部系统，在用户将据此行动前应先验证当前状态。',
    '- 如果记忆与当前仓库或当前环境冲突，以当前验证结果为准，并在合适时更新记忆。'
  ]
}

/** 生成「不应保存的内容」说明段落。 */
export function buildMemoryExclusionGuidance(): string[] {
  return [
    '## 不应保存的内容',
    '- 不保存能从当前仓库直接读取的代码结构、文件内容、脚本命令或架构细节。',
    '- 不保存 git 已经能表达的提交历史、diff、作者信息。',
    '- 不保存一次性调试过程、临时计划、当前任务进度或无长期价值的中间输出。',
    '- 不把项目记忆当活动日志；只保存未来对话仍然有用、非显而易见的信息。'
  ]
}

/** 生成「记忆与会话历史边界」说明段落。 */
export function buildMemoryPersistenceBoundaryGuidance(): string[] {
  return [
    '## 记忆边界',
    '会话历史保存一次对话过程；项目记忆只沉淀跨对话仍然成立、能改变未来判断或协作方式的信息。'
  ]
}
