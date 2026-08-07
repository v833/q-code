import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('ACP CLI', () => {
  it('serves initialize, session/new and session/close over stdio', async () => {
    const cwd = process.cwd()
    const qCodeHome = mkdtempSync(join(tmpdir(), 'q-code-acp-test-'))
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/index.ts', 'acp', '--cd', cwd], {
      cwd,
      env: { ...process.env, Q_CODE_HOME: qCodeHome, Q_CODE_TUI: '0' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: { name: 'q-code-test', version: '1' },
          clientCapabilities: {}
        }
      })}\n`)
      await waitForResponse(() => stdout, 1, 10_000, () => stderr)

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd, mcpServers: [] }
      })}\n`)
      const newSession = JSON.parse(await waitForResponse(() => stdout, 2)) as {
        result?: { sessionId?: string }
      }
      expect(newSession.result?.sessionId).toMatch(/^[a-f0-9-]{36}$/)

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/close',
        params: { sessionId: newSession.result?.sessionId }
      })}\n`)
      expect(await waitForResponse(() => stdout, 3)).toContain('"result":{}')
      child.stdin.end()
      await waitForExit(child)
      expect(stderr).not.toContain('Unhandled')
      expect(stdout.trim().split(/\r?\n/).every((line) => JSON.parse(line).jsonrpc === '2.0')).toBe(true)
    } finally {
      child.kill()
      rmSync(qCodeHome, { recursive: true, force: true })
    }
  }, 15_000)

  it('streams agent text and tool updates for a prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-acp-prompt-'))
    const cwd = join(root, 'project')
    const projectRoot = process.cwd()
    const qCodeHome = join(root, 'q-code-home')
    const sessionDir = join(root, 'sessions')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(qCodeHome, { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    const { server, baseUrl } = await startMockOpenAiServer()
    const child = spawn(process.execPath, [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(projectRoot, 'src', 'index.ts'), 'acp', '--cd', cwd], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'dummy',
        OPENAI_BASE_URL: baseUrl,
        OPENAI_MODEL: 'mock-model',
        SUMMARY_API_KEY: 'dummy',
        SUMMARY_BASE_URL: baseUrl,
        SUMMARY_MODEL: 'summary-model',
        Q_CODE_HOME: qCodeHome,
        Q_CODE_SESSION_DIR: sessionDir,
        Q_CODE_TUI: '0',
        Q_CODE_AUDIT_ENABLED: 'false',
        Q_CODE_CRASH_GUARD: 'false',
        Q_CODE_HISTORY_DISABLED: 'true',
        Q_CODE_INFRA_ENABLED: 'false',
        Q_CODE_INFRA_SYNC: 'false',
        Q_CODE_LANGFUSE_ENABLED: 'false',
        Q_CODE_GITLAB_KB_ENABLED: 'false',
        Q_CODE_CHANGELOG: '0',
        MCP_CONNECT_TIMEOUT_MS: '50'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let spawnError: Error | undefined
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { spawnError = error })

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} }
      })}\n`)
      await waitForResponse(() => stdout, 1, 10_000, () => {
        return `${stderr}${spawnError ? `\nspawn error: ${spawnError.message}` : ''}`
      })
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'session/new',
        params: { cwd, mcpServers: [] }
      })}\n`)
      const sessionResponse = JSON.parse(await waitForResponse(() => stdout, 2, 10_000, () => stderr)) as {
        result: { sessionId: string }
      }
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 4, method: 'session/prompt',
        params: { sessionId: sessionResponse.result.sessionId, prompt: [{ type: 'text', text: '检查项目' }] }
      })}\n`)
      const promptLine = await waitForResponse(() => stdout, 4, 30_000, () => {
        return `${stderr}${spawnError ? `\nspawn error: ${spawnError.message}` : ''}`
      })
      const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      const updates = messages.filter((message) => message.method === 'session/update')
      expect(updates.some((message) => JSON.stringify(message).includes('tool_call'))).toBe(true)
      expect(updates.some((message) => JSON.stringify(message).includes('mock answer'))).toBe(true)
      expect(JSON.parse(promptLine)).toMatchObject({ result: { stopReason: 'end_turn' } })
      child.stdin.end()
      await waitForExit(child)
      expect(stderr).not.toContain('Unhandled')
    } finally {
      if (child.exitCode === null) {
        child.kill()
        await waitForExit(child)
      }
      await closeServer(server)
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)
})

async function waitForResponse(
  readStdout: () => string,
  id: number,
  timeoutMs = 10_000,
  readStderr: () => string = () => ''
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = readStdout().trim().split(/\r?\n/).find((candidate) => candidate.includes(`"id":${id}`))
    if (line) return line
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待 ACP response 超时: id=${id}\nstdout:\n${readStdout()}\nstderr:\n${readStderr()}`)
}

async function startMockOpenAiServer(): Promise<{ server: Server; baseUrl: string }> {
  let requestCount = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requestCount += 1
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      if (requestCount === 1) {
        response.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'f', arguments: '{"command":"Get-Location"}' } }] }, index: 0 }] }))
        response.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }))
      } else {
        response.write(sse({ choices: [{ delta: { content: 'mock answer' }, index: 0 }] }))
        response.write(sse({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }))
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

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve())
    child.once('error', reject)
  })
}
