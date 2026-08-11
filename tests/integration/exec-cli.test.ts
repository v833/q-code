import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listProjectSessionsFast } from '../../src/session/store'

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

interface MockServerState {
  requests: Array<{
    model?: string
    messages?: Array<{ role?: string; content?: unknown }>
    tools?: Array<{ function?: { name?: string } }>
  }>
}

describe('Codex-compatible exec subprocess', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it('supports the agent-os first-turn and resume contract with tool progress', async () => {
    const fixture = createFixture()
    cleanups.push(fixture.dispose)
    const state: MockServerState = { requests: [] }
    const mock = await startMockOpenAiServer(state)
    cleanups.push(() => closeServer(mock.server))
    const env = createCliEnv(fixture, mock.baseUrl)

    const first = await runCli([
      'exec',
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      'first prompt',
    ], fixture.cwd, env)
    expect(first.code, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0)
    const firstEvents = parseJsonLines(first.stdout)
    const thread = firstEvents.find((event) => event.type === 'thread.started')
    expect(thread?.thread_id).toEqual(expect.any(String))
    const locationExecution = firstEvents.find((event) =>
      event.type === 'item.completed'
      && event.item
      && typeof event.item === 'object'
      && (event.item as Record<string, unknown>).type === 'command_execution'
      && (event.item as Record<string, unknown>).command === 'Get-Location'
    )
    expect(locationExecution).toBeDefined()
    const locationItem = locationExecution?.item as Record<string, unknown> | undefined
    expect(locationItem).toEqual(expect.objectContaining({
      type: 'command_execution',
      command: 'Get-Location',
      status: expect.stringMatching(/^(completed|failed)$/),
    }))
    if (locationItem?.status === 'failed') {
      expect(locationItem.exit_code).toEqual(expect.any(Number))
    }
    expect(lastAgentMessage(firstEvents)).toBe('mock answer')
    expect(firstEvents.at(-1)).toMatchObject({
      type: 'turn.completed',
      usage: { output_tokens: 3 },
    })

    const sessionId = String(thread?.thread_id)
    const resumed = await runCli([
      'exec',
      'resume',
      sessionId,
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      'second prompt',
    ], fixture.cwd, env)
    expect(resumed.code, `stdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`).toBe(0)
    const resumedEvents = parseJsonLines(resumed.stdout)
    expect(resumedEvents[0]).toEqual({ type: 'thread.started', thread_id: sessionId })
    expect(lastAgentMessage(resumedEvents)).toBe('mock answer')

    const requestDump = JSON.stringify(state.requests)
    expect(requestDump).toContain('first prompt')
    expect(requestDump).toContain('second prompt')
  }, 45_000)

  it('returns a JSON error and exit code 2 for an unknown resume session', async () => {
    const fixture = createFixture()
    cleanups.push(fixture.dispose)
    const result = await runCli([
      'exec', 'resume', 'missing-session', '--json', 'continue',
    ], fixture.cwd, createCliEnv(fixture, 'http://127.0.0.1:1/v1'))

    expect(result.code).toBe(2)
    expect(parseJsonLines(result.stdout)).toEqual([
      expect.objectContaining({ type: 'error' }),
    ])
  })

  it('supports stdin, cwd, model, image, output file and ephemeral mode', async () => {
    const fixture = createFixture()
    cleanups.push(fixture.dispose)
    const imagePath = join(fixture.cwd, 'pixel.png')
    writeFileSync(
      imagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64'),
    )
    const state: MockServerState = { requests: [] }
    const mock = await startMockOpenAiServer(state)
    cleanups.push(() => closeServer(mock.server))

    const result = await runCli([
      'exec',
      '-C', fixture.cwd,
      '--json',
      '--ephemeral',
      '--model', 'override-model',
      '--image', 'pixel.png',
      '--output-last-message', 'answer.txt',
      '--color', 'never',
      '-',
    ], fixture.root, createCliEnv(fixture, mock.baseUrl), 'stdin prompt\n')

    expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    expect(lastAgentMessage(parseJsonLines(result.stdout))).toBe('mock answer')
    expect(readFileSync(join(fixture.cwd, 'answer.txt'), 'utf-8')).toBe('mock answer')
    expect(state.requests.every((request) => request.model === 'override-model')).toBe(true)
    expect(JSON.stringify(state.requests)).toContain('stdin prompt')
    expect(JSON.stringify(state.requests)).toContain('data:image/png;base64')
    expect(listProjectSessionsFast({ cwd: fixture.cwd, sessionDir: fixture.sessionDir })).toEqual([])
  }, 30_000)

  it('maps read-only sandbox to read-only tool visibility', async () => {
    const fixture = createFixture()
    cleanups.push(fixture.dispose)
    const state: MockServerState = { requests: [] }
    const mock = await startMockOpenAiServer(state, { withTool: false })
    cleanups.push(() => closeServer(mock.server))

    const result = await runCli([
      'exec', '--json', '--sandbox', 'read-only', 'inspect only',
    ], fixture.cwd, createCliEnv(fixture, mock.baseUrl))

    expect(result.code, result.stderr).toBe(0)
    const toolNames = state.requests[0]?.tools?.map((tool) => tool.function?.name) ?? []
    expect(toolNames).toContain('read_file')
    expect(toolNames).not.toContain('f')
    expect(toolNames).not.toContain('write_file')
    expect(toolNames).not.toContain('edit_file')
  }, 30_000)

  it('emits turn.failed when the final output file cannot be written', async () => {
    const fixture = createFixture()
    cleanups.push(fixture.dispose)
    const state: MockServerState = { requests: [] }
    const mock = await startMockOpenAiServer(state, { withTool: false })
    cleanups.push(() => closeServer(mock.server))

    const result = await runCli([
      'exec', '--json', '-o', 'missing/answer.txt', 'write the answer',
    ], fixture.cwd, createCliEnv(fixture, mock.baseUrl))

    expect(result.code).toBe(1)
    const events = parseJsonLines(result.stdout)
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed' })
    expect(events.some((event) => event.type === 'turn.completed')).toBe(false)
  }, 30_000)
})

function createFixture(): {
  root: string
  cwd: string
  home: string
  qcodeHome: string
  sessionDir: string
  dispose: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'q-code-exec-cli-'))
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  const qcodeHome = join(root, 'q-code-home')
  const sessionDir = join(root, 'sessions')
  for (const directory of [cwd, home, qcodeHome, sessionDir]) {
    mkdirSync(directory, { recursive: true })
  }
  return {
    root,
    cwd,
    home,
    qcodeHome,
    sessionDir,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

function createCliEnv(
  fixture: ReturnType<typeof createFixture>,
  baseUrl: string,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    NO_COLOR: '1',
    CI: '1',
    OPENAI_API_KEY: 'dummy',
    OPENAI_BASE_URL: baseUrl,
    OPENAI_MODEL: 'mock-model',
    SUMMARY_API_KEY: 'dummy',
    SUMMARY_BASE_URL: baseUrl,
    SUMMARY_MODEL: 'summary-model',
    Q_CODE_HOME: fixture.qcodeHome,
    Q_CODE_SESSION_DIR: fixture.sessionDir,
    Q_CODE_TUI: '0',
    Q_CODE_AUDIT_ENABLED: 'false',
    Q_CODE_CRASH_GUARD: 'false',
    Q_CODE_HISTORY_DISABLED: 'true',
    Q_CODE_INFRA_ENABLED: 'false',
    Q_CODE_INFRA_SYNC: 'false',
    Q_CODE_LANGFUSE_ENABLED: 'false',
    Q_CODE_GITLAB_KB_ENABLED: 'false',
    Q_CODE_CHANGELOG: '0',
    MCP_CONNECT_TIMEOUT_MS: '50',
  }
}

async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'src/index.ts'),
      ...args,
    ],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  child.stdout.setEncoding('utf-8')
  child.stderr.setEncoding('utf-8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.stdin.end(stdin)

  return new Promise<CliResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`exec subprocess timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 30_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

function lastAgentMessage(events: Array<Record<string, unknown>>): string | undefined {
  return events.flatMap((event) => {
    if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') return []
    const item = event.item as Record<string, unknown>
    return item.type === 'agent_message' && typeof item.text === 'string' ? [item.text] : []
  }).at(-1)
}

async function startMockOpenAiServer(
  state: MockServerState,
  options: { withTool?: boolean } = {},
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }

    let body = ''
    request.setEncoding('utf-8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as MockServerState['requests'][number]
      state.requests.push(payload)
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (options.withTool !== false && state.requests.length % 2 === 1) {
        response.write(sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `call-${state.requests.length}`,
                type: 'function',
                function: { name: 'f', arguments: '{"command":"Get-Location"}' },
              }],
            },
            index: 0,
          }],
        }))
        response.write(sse({
          choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }))
      } else {
        response.write(sse({ choices: [{ delta: { content: 'mock answer' }, index: 0 }] }))
        response.write(sse({
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }))
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server did not bind')
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` }
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose())
  })
}
