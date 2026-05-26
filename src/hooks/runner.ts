/**
 * 默认 Hook 运行器：顺序执行已注册定义，聚合 block/modify 决策并写审计。
 */
import { runCommandHook } from './command-runner'
import { matchesHook } from './matcher'
import type {
  HookDefinition,
  HookEvent,
  HookExecutionRecord,
  HookHandlerResult,
  HookRunResult,
  HookRunner
} from './types'
import { createHookDecisionPayload, getAuditLogger } from '../observability/audit'

const CONTINUE: HookHandlerResult = { action: 'continue' }

/** 实现 {@link HookRunner}，支持 command 与 in-process handler 两类定义。 */
export class DefaultHookRunner implements HookRunner {
  private definitions: HookDefinition[]

  constructor(definitions: HookDefinition[] = []) {
    this.definitions = definitions
  }

  register(...definitions: HookDefinition[]): void {
    this.definitions.push(...definitions)
  }

  list(): HookDefinition[] {
    return [...this.definitions]
  }

  describe(): string {
    if (this.definitions.length === 0) return 'Hooks (0 loaded)'

    const lines = [`Hooks (${this.definitions.length} loaded)`, '']
    for (const definition of this.definitions) {
      const matcher = definition.matcher ? ` matcher=${JSON.stringify(definition.matcher)}` : ''
      const mode = definition.blocking === false ? 'non-blocking' : 'blocking'
      const source = definition.sourcePath ? ` ${definition.sourcePath}` : ''
      lines.push(
        `- ${definition.name} [${definition.scope}, ${definition.type}, ${mode}] event=${definition.event}${matcher}${source}`
      )
    }
    return lines.join('\n')
  }

  async run(event: HookEvent, options: { signal?: AbortSignal } = {}): Promise<HookRunResult> {
    const records: HookExecutionRecord[] = []
    const warnings: string[] = []
    let nextInput: unknown = 'tool' in event ? event.tool.input : undefined
    let nextOutput: unknown = event.event === 'post_tool_use' ? event.tool.output : undefined

    for (const definition of this.definitions) {
      const matched = matchesHook(definition, event)
      if (!matched) {
        records.push({
          hookName: definition.name,
          event: event.event,
          scope: definition.scope,
          matched: false
        })
        continue
      }

      const started = Date.now()
      try {
        const result = normalizeResult(await executeDefinition(definition, event, options))
        const durationMs = Date.now() - started
        getAuditLogger().emit(
          'hook.decision',
          createHookDecisionPayload({
            hookName: definition.name,
            event: event.event,
            scope: definition.scope,
            matched: true,
            action: result.action,
            durationMs,
            ...(result.action === 'block' ? { reason: result.reason } : {}),
            ...(result.action === 'warn' ? { message: result.message } : {})
          }),
          {
            sessionId: event.sessionId,
            cwd: event.cwd,
            agent: event.agent
          }
        )
        records.push({
          hookName: definition.name,
          event: event.event,
          scope: definition.scope,
          matched: true,
          durationMs,
          action: result.action,
          message: result.action === 'warn' ? result.message : undefined
        })

        if (result.action === 'warn') warnings.push(result.message)
        if (result.action === 'block') {
          return {
            blocked: true,
            reason: result.reason,
            input: nextInput,
            output: nextOutput,
            warnings,
            records
          }
        }
        if (result.action === 'modify') {
          if ('input' in result) nextInput = result.input
          if ('output' in result) nextOutput = result.output
          if (result.message) warnings.push(result.message)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        getAuditLogger().emit(
          'hook.decision',
          createHookDecisionPayload({
            hookName: definition.name,
            event: event.event,
            scope: definition.scope,
            matched: true,
            action: definition.blocking === false ? 'warn' : 'block',
            reason: message,
            durationMs: Date.now() - started
          }),
          {
            sessionId: event.sessionId,
            cwd: event.cwd,
            agent: event.agent
          }
        )
        records.push({
          hookName: definition.name,
          event: event.event,
          scope: definition.scope,
          matched: true,
          durationMs: Date.now() - started,
          error: message
        })
        if (definition.blocking === false) {
          warnings.push(`[hook:${definition.name}] ${message}`)
          continue
        }
        return {
          blocked: true,
          reason: `[hook:${definition.name}] ${message}`,
          input: nextInput,
          output: nextOutput,
          warnings,
          records
        }
      }
    }

    return {
      blocked: false,
      input: nextInput,
      output: nextOutput,
      warnings,
      records
    }
  }
}

async function executeDefinition(
  definition: HookDefinition,
  event: HookEvent,
  options: { signal?: AbortSignal }
): Promise<HookHandlerResult | void> {
  if (definition.type === 'command') {
    return runCommandHook(definition, event, options)
  }
  return definition.handler(event, { signal: options.signal })
}

function normalizeResult(result: HookHandlerResult | void): HookHandlerResult {
  if (!result) return CONTINUE
  return result
}
