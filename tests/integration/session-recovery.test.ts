import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { SessionStore } from '../../src/session/store'
import { setupTempHome, type TempHome } from '../_helpers/temp-home'

/**
 * SessionStore 用 append-only JSONL 持久化对话历史。崩溃语义：
 *   - 进程在 append 中途死掉 → 末尾会留下半行 JSON
 *   - 下次 load 时逐行解析，损坏行直接跳过，前面的会话历史完好
 *   - 压缩快照（compaction）会作为分界点：load 只返回最后一次快照之后的消息
 */
describe('SessionStore JSONL 损坏与恢复', () => {
  let home: TempHome
  beforeEach(() => {
    home = setupTempHome('session-recovery-')
  })
  afterEach(() => {
    home.dispose()
  })

  function makeStore(opts: { sessionId?: string; continueLatest?: boolean } = {}) {
    return new SessionStore({
      cwd: home.cwd,
      sessionDir: '.sessions', // 默认值，但显式以避免读取环境
      ...opts
    })
  }

  it('写入 + load 无崩溃时全部消息可恢复', () => {
    const store = makeStore({ sessionId: 'happy-path' })
    store.append({ role: 'user', content: 'hi' })
    store.append({ role: 'assistant', content: '你好' })
    store.append({ role: 'user', content: 'how' })

    const reloaded = makeStore({ sessionId: 'happy-path' }).load()
    expect(reloaded).toHaveLength(3)
    expect(reloaded[0]?.role).toBe('user')
    expect(reloaded[2]?.content).toBe('how')
  })

  it('末尾半行损坏时丢弃损坏行，前面历史完好', () => {
    const store = makeStore({ sessionId: 'broken-tail' })
    store.append({ role: 'user', content: 'msg1' })
    store.append({ role: 'assistant', content: 'msg2' })

    // 直接对 transcript 文件追加半行 JSON，模拟 append_file_sync 在中途被 SIGKILL
    appendFileSync(store.paths.transcriptPath, '{"type":"message","timesta', 'utf-8')

    // 重开 store 应只看到前两条完好消息
    const reloaded = makeStore({ sessionId: 'broken-tail' }).load()
    expect(reloaded).toHaveLength(2)
    expect(reloaded[0]?.content).toBe('msg1')
    expect(reloaded[1]?.content).toBe('msg2')
  })

  it('中间夹带损坏行时跳过，前后好行均可恢复', () => {
    const store = makeStore({ sessionId: 'middle-broken' })
    store.append({ role: 'user', content: 'A' })
    store.append({ role: 'user', content: 'B' })

    // 手工拼接：在两条好消息之间插一条损坏行
    const original = readFileSync(store.paths.transcriptPath, 'utf-8')
    writeFileSync(
      store.paths.transcriptPath,
      original + 'this is not json\n' + JSON.stringify({
        type: 'message',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'C' }
      }) + '\n',
      'utf-8'
    )

    const reloaded = makeStore({ sessionId: 'middle-broken' }).load()
    // A、B、C 三条都恢复（损坏行被静默跳过）
    expect(reloaded.map((m) => m.content)).toEqual(['A', 'B', 'C'])
  })

  it('压缩快照之后 load 只返回快照后的消息', () => {
    const store = makeStore({ sessionId: 'compaction-divider' })
    store.append({ role: 'user', content: '旧消息1' })
    store.append({ role: 'user', content: '旧消息2' })

    // 压缩：写入摘要快照，把"摘要消息"作为新的活跃前缀
    store.appendCompactionSnapshot({
      trigger: 'preflight',
      beforeTokens: 10000,
      afterTokens: 1000,
      messages: [
        { role: 'system', content: '<会话摘要>之前讨论过 ABC</会话摘要>' },
        { role: 'user', content: '基于摘要继续' }
      ]
    })

    // 快照后再追加新消息
    store.append({ role: 'assistant', content: '收到' })

    const reloaded = makeStore({ sessionId: 'compaction-divider' }).load()
    // 应只看到快照后的 3 条：摘要 system + user 摘要 + 新 assistant
    expect(reloaded).toHaveLength(3)
    expect(reloaded[0]?.role).toBe('system')
    expect(reloaded[2]?.role).toBe('assistant')
  })

  it('--continue 行为：可恢复最近一次会话', () => {
    const a = makeStore({ sessionId: 'session-A' })
    a.append({ role: 'user', content: 'A1' })

    const b = makeStore({ sessionId: 'session-B' })
    b.append({ role: 'user', content: 'B1' })

    const continued = makeStore({ continueLatest: true })
    expect(continued.sessionId).toBe('session-B') // 最近写的
    expect(continued.load()[0]?.content).toBe('B1')
  })

  it('exists() 在新建会话时为 false，在已有 transcript 时为 true', () => {
    const store = makeStore({ sessionId: 'exists-flag' })
    // session_meta 在 ctor 写入，但 existedBeforeInit 是相对于"构造前是否存在 transcript"
    expect(store.exists()).toBe(false)

    const reopened = makeStore({ sessionId: 'exists-flag' })
    expect(reopened.exists()).toBe(true)
  })

  it('usage_v2 记录可恢复，旧 usage 兼容逻辑不受影响', () => {
    const store = makeStore({ sessionId: 'usage-v2' })
    store.appendUsage(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    )
    store.appendUsageV2(
      {
        timestamp: '2026-05-25T00:00:00.000Z',
        model: 'mock-model',
        cacheMode: 'auto',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
          totalTokens: 200
        },
        pricingModel: 'mock-model',
        cost: {
          cost: 0.001,
          baselineCost: 0.002,
          savedCost: 0.001
        }
      },
      {
        steps: 1,
        cacheMode: 'auto',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
          totalTokens: 200
        },
        cost: {
          cost: 0.001,
          baselineCost: 0.002,
          savedCost: 0.001
        },
        unknownCostSteps: 0,
        cacheHitRate: 80 / 180
      }
    )

    const reopened = makeStore({ sessionId: 'usage-v2' })
    expect(reopened.getUsageRecords()).toHaveLength(1)
    expect(reopened.getUsageRecords()[0]?.usage.cacheReadTokens).toBe(80)
    expect(reopened.getSummary().totalUsage?.totalTokens).toBe(15)
    expect(reopened.getSummary().usageTotals?.usage.totalTokens).toBe(200)
  })

  it('cache_mode 记录可恢复，用于继续会话时保留 cache 策略', () => {
    const store = makeStore({ sessionId: 'cache-mode' })
    store.appendCacheMode('off')
    store.appendCacheMode('on')

    const reopened = makeStore({ sessionId: 'cache-mode' })
    expect(reopened.getLatestCacheMode()).toBe('on')
  })
})

describe('CLI session model boundary', () => {
  it('restores --session history while sending the current runtime model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-session-model-boundary-'))
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    const qcodeHome = join(root, 'qcode-home')
    const sessionDir = join(root, 'sessions')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(qcodeHome, { recursive: true })
    const cliCwd = realpathSync(cwd)

    const seeded = new SessionStore({ cwd: cliCwd, sessionDir, sessionId: 'old-session' })
    seeded.append({ role: 'user', content: 'old prompt' })
    seeded.appendUsageV2(
      {
        timestamp: '2026-06-01T00:00:00.000Z',
        model: 'old-model',
        cacheMode: 'auto',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15
        },
        pricingModel: 'old-model',
        cost: { cost: 0, baselineCost: 0, savedCost: 0 }
      },
      {
        steps: 1,
        cacheMode: 'auto',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15
        },
        cost: { cost: 0, baselineCost: 0, savedCost: 0 },
        unknownCostSteps: 0,
        cacheHitRate: 0
      }
    )

    const serverState: { models: string[]; prompts: string[] } = { models: [], prompts: [] }
    const server = await startMockOpenAiServer(serverState)

    try {
      const child = spawn(
        process.execPath,
        [
          join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
          join(process.cwd(), 'src/index.ts'),
          '--classic',
          '--session',
          'old-session'
        ],
        {
          cwd: cliCwd,
          env: {
            ...baseCliEnv({ home, qcodeHome }),
            OPENAI_BASE_URL: server.baseUrl,
            OPENAI_MODEL: 'new-model',
            SUMMARY_BASE_URL: server.baseUrl,
            SUMMARY_MODEL: 'summary-model',
            Q_CODE_SESSION_DIR: sessionDir
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32'
        }
      )
      const output = collectOutput(child)

      await waitForOutput(output, 'You:')
      let promptCount = countPromptOccurrences(output)
      child.stdin.write('new prompt\n')
      await waitForOutput(output, 'ok')
      promptCount = await waitForNextPrompt(output, promptCount)
      child.stdin.write('exit\n')
      await waitForExit(child, output)

      expect(output.text).toContain('恢复会话 "old-session"')
      expect(output.text).toContain('历史模型: old-model')
      expect(output.text).toContain('当前模型: new-model')
      expect(serverState.models).toContain('new-model')
      expect(serverState.models).not.toContain('old-model')
      expect(serverState.prompts.join('\n')).toContain('old prompt')
      expect(serverState.prompts.join('\n')).toContain('new prompt')
      expect(new SessionStore({ cwd: cliCwd, sessionDir, sessionId: 'old-session' }).getSummary().model).toBe(
        'old-model'
      )
    } finally {
      await closeServer(server.server)
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
})

function collectOutput(child: ChildProcessWithoutNullStreams): { text: string } {
  const output = { text: '' }
  child.stdout.setEncoding('utf-8')
  child.stderr.setEncoding('utf-8')
  child.stdout.on('data', (chunk) => {
    output.text += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output.text += String(chunk)
  })
  return output
}

async function waitForOutput(output: { text: string }, needle: string, timeoutMs = 10000): Promise<void> {
  const started = Date.now()
  while (!output.text.includes(needle)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${JSON.stringify(needle)}.\nOutput:\n${output.text}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForNextPrompt(
  output: { text: string },
  previousCount: number,
  timeoutMs = 10000
): Promise<number> {
  const started = Date.now()
  while (countPromptOccurrences(output) <= previousCount) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for next prompt.\nOutput:\n${output.text}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return countPromptOccurrences(output)
}

function countPromptOccurrences(output: { text: string }): number {
  return output.text.match(/\nYou: /g)?.length ?? 0
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  output: { text: string },
  timeoutMs = 20000
): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Timed out waiting for q-code process to exit.\nOutput:\n${output.text}`))
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`q-code exited with code ${code}.\nOutput:\n${output.text}`))
    })
  })
}

function baseCliEnv(options: { home: string; qcodeHome: string }): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    HOME: options.home,
    USERPROFILE: options.home,
    NO_COLOR: '1',
    CI: '1',
    OPENAI_API_KEY: 'dummy',
    SUMMARY_API_KEY: 'dummy',
    Q_CODE_HOME: options.qcodeHome,
    Q_CODE_TUI: '0',
    Q_CODE_AUDIT_ENABLED: 'false',
    Q_CODE_CRASH_GUARD: 'false',
    Q_CODE_HISTORY_DISABLED: 'true',
    Q_CODE_INFRA_ENABLED: 'false',
    Q_CODE_INFRA_SYNC: 'false',
    Q_CODE_LANGFUSE_ENABLED: 'false',
    Q_CODE_GITLAB_KB_ENABLED: 'false',
    Q_CODE_CHANGELOG: '0',
    MCP_CONNECT_TIMEOUT_MS: '100'
  }
}

async function startMockOpenAiServer(
  state: { models: string[]; prompts: string[] }
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }

    let body = ''
    req.setEncoding('utf-8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const payload = JSON.parse(body) as { model?: string; messages?: unknown[] }
      if (payload.model) state.models.push(payload.model)
      state.prompts.push(JSON.stringify(payload.messages ?? []))
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, index: 0 }] })}\n\n`)
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
        })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock OpenAI server did not bind to a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
