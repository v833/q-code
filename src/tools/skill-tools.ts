/**
 * Skill 工具：模型通过 `Skill` 加载 SKILL.md 工作流正文。
 */
import { buildSkillPromptText, SKILL_NAME_RE } from '../skills/invocation'
import { findSkill, getModelVisibleSkills } from '../skills/registry'
import type { ToolDefinition } from './registry'

/** Skill 工具所需的 sessionId 提供者。 */
export interface SkillToolController {
  getSessionId: () => string
}

interface SkillInput {
  skill: string
  args?: string
}

/** 创建 `Skill` 工具定义。 */
export function createSkillTool(controller: SkillToolController): ToolDefinition {
  return {
    name: 'Skill',
    description:
      '执行一个已加载的 Skill。传入 system-reminder 中列出的 skill 名称和可选 args；工具会返回该 Skill 的完整工作流指令，然后你必须按这些指令继续本轮任务。只有当用户请求匹配某个 Skill 时才调用。',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill 名称，必须完全匹配 system-reminder 中的 name'
        },
        args: {
          type: 'string',
          description: '可选参数字符串，会替换 SKILL.md 正文中的 $ARGUMENTS'
        }
      },
      required: ['skill'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    contextCost: 'medium',
    resultShape: 'meta',
    jitHint: '命中 Skill 时才加载完整工作流',
    isEnabled: () => getModelVisibleSkills().length > 0,
    execute: async (input: SkillInput) => {
      const name = typeof input.skill === 'string' ? input.skill.trim() : ''
      const args = typeof input.args === 'string' ? input.args : ''

      if (!name || !SKILL_NAME_RE.test(name)) {
        return `Error: invalid skill name. Must match ${SKILL_NAME_RE}. Got: ${JSON.stringify(name)}`
      }

      const skill = findSkill(name)
      if (!skill) {
        return `Error: skill "${name}" not found. Use /skills to list loaded skills.`
      }

      if (skill.frontmatter.disableModelInvocation) {
        return `Error: skill "${name}" has disable-model-invocation: true and can only be invoked by the user via /${name}.`
      }

      if (skill.frontmatter.hasForkContext) {
        return `Error: skill "${name}" declares context: fork, which is not supported in q-code's inline Skills implementation yet.`
      }

      return [
        `Loaded skill "${skill.name}" (${skill.source}).`,
        'Follow the instructions below - they ARE your next steps for this turn.',
        '',
        buildSkillPromptText(skill, args, controller.getSessionId())
      ].join('\n')
    }
  }
}
