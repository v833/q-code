/**
 * Plan Mode 工具：enter_plan_mode、plan_write、exit_plan_mode。
 */
import { buildFullPlanModeText } from '../context/plan-attachments'
import type { ToolDefinition, ToolVisibilityMode } from './registry'

/** Plan 工具依赖的运行时控制器（模式切换与计划文件读写）。 */
export interface PlanToolController {
  getMode: () => ToolVisibilityMode
  setMode: (mode: ToolVisibilityMode) => void
  getPlanFilePath: () => string
  readPlan: () => Promise<string | null>
  writePlan: (content: string) => Promise<string>
  markPlanReady: (summary: string) => void
}

/** 创建 Plan Mode 相关工具数组。 */
export function createPlanTools(controller: PlanToolController): ToolDefinition[] {
  return [
    createEnterPlanModeTool(controller),
    createPlanWriteTool(controller),
    createExitPlanModeTool(controller)
  ]
}

function createEnterPlanModeTool(controller: PlanToolController): ToolDefinition {
  return {
    name: 'enter_plan_mode',
    description:
      '进入 Plan Mode：只读探索代码并编写计划，等用户批准后再执行修改。适合复杂、多文件或需要先确认方案的任务',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '为什么需要先进入 Plan Mode'
        }
      },
      required: ['reason'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    allowInPlanMode: true,
    contextCost: 'low',
    resultShape: 'state',
    jitHint: '复杂任务先进入只读规划',
    execute: async () => {
      if (controller.getMode() === 'plan') {
        return '已经处于 Plan Mode。'
      }

      controller.setMode('plan')
      return buildFullPlanModeText(controller.getPlanFilePath())
    }
  }
}

function createPlanWriteTool(controller: PlanToolController): ToolDefinition {
  return {
    name: 'plan_write',
    description:
      '写入当前会话的计划文件。Plan Mode 下只能用这个工具保存实施计划，不要使用 write_file/edit_file 修改项目文件',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '完整 Markdown 计划内容'
        }
      },
      required: ['content'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    allowInPlanMode: true,
    contextCost: 'medium',
    resultShape: 'mutation',
    jitHint: '保存计划，不修改项目文件',
    execute: async ({ content }: { content: string }) => {
      if (controller.getMode() !== 'plan') {
        return 'plan_write 只能在 Plan Mode 中使用。'
      }

      const filePath = await controller.writePlan(content)
      return `计划已保存到 ${filePath}（${content.length} 字符）。`
    }
  }
}

function createExitPlanModeTool(controller: PlanToolController): ToolDefinition {
  return {
    name: 'exit_plan_mode',
    description:
      '提交计划并退出 Plan Mode。调用后当前 agent loop 会停止，等待用户输入 /approve-plan 执行或 /revise-plan 继续修订',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '对计划的简短总结'
        },
        plan: {
          type: 'string',
          description: '可选。如果提供，将先覆盖写入计划文件'
        }
      },
      required: ['summary'],
      additionalProperties: false
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    allowInPlanMode: true,
    contextCost: 'medium',
    resultShape: 'state',
    jitHint: '提交计划并等待用户批准',
    execute: async ({ summary, plan }: { summary: string; plan?: string }) => {
      if (controller.getMode() !== 'plan') {
        return 'exit_plan_mode 只能在 Plan Mode 中使用。'
      }

      if (typeof plan === 'string') {
        await controller.writePlan(plan)
      }

      const planContent = await controller.readPlan()
      if (!planContent?.trim()) {
        return '未找到计划内容。请先使用 plan_write，或在 exit_plan_mode 中传入非空 plan。'
      }

      controller.setMode('normal')
      controller.markPlanReady(summary || 'Plan submitted.')

      return [
        '计划已提交。当前 loop 会停止，等待用户确认。',
        `计划文件: ${controller.getPlanFilePath()}`,
        `摘要: ${summary || '未提供摘要。'}`,
        planContent
          ? '下一步：用户可以输入 /approve-plan 执行，或 /revise-plan <反馈> 继续规划。'
          : '警告：磁盘上没有找到计划内容。'
      ].join('\n')
    }
  }
}
