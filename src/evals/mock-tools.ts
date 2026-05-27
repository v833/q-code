/**
 * Eval mock 工具注册：从 case 文件中的轻量配置生成 ToolDefinition。
 */
import type { ToolDefinition } from '../tools/registry'
import type { EvalMockToolSpec } from './types'

/** 将 eval case 的 mock tool 配置转换为 ToolDefinition。 */
export function createEvalMockTools(specs: EvalMockToolSpec[] = []): ToolDefinition[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: `eval mock tool ${spec.name}`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async () => {
      if (spec.delayMs && spec.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, spec.delayMs))
      }
      if (spec.error) {
        return {
          ok: false,
          error: spec.error,
          code: 'eval_mock_tool_error'
        }
      }
      return spec.output ?? 'ok'
    }
  }))
}
