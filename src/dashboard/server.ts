/**
 * 本地 Web Dashboard 服务：提供只读 API 与单页静态界面。
 *
 * 默认绑定 `127.0.0.1`，读取本地 artifact，不上传数据，也不展示敏感原文。
 */
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { getStringArg } from '../runtime/cli-utils'
import {
  collectDashboardData,
  collectDashboardSessionDetail,
  formatDashboardPath,
  type DashboardDataOptions,
  type DashboardSnapshot
} from './data'

/** Dashboard HTTP 服务启动选项。 */
export interface DashboardServerOptions extends DashboardDataOptions {
  host?: string
  port?: number
  open?: boolean
  stdout?: (line: string) => void
}

/** 已启动的 Dashboard 服务。 */
export interface DashboardServerHandle {
  server: Server
  host: string
  port: number
  url: string
  close: () => Promise<void>
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 48888
const SNAPSHOT_CACHE_TTL_MS = 1000

interface DashboardSnapshotCache {
  value?: {
    key: string
    expiresAt: number
    snapshot: DashboardSnapshot
  }
}

interface DashboardRuntimeOptions extends DashboardServerOptions {
  snapshotCache: DashboardSnapshotCache
}

/** 执行 `q-code dashboard` CLI。 */
export async function runDashboardCli(argv: string[], options: DashboardServerOptions = {}): Promise<number> {
  if (argv.includes('help') || argv.includes('--help') || argv.includes('-h')) {
    console.log(formatDashboardHelp())
    return 0
  }

  const parsed = parseDashboardArgs(argv)
  const server = await startDashboardServer({
    ...options,
    ...parsed,
    cwd: options.cwd ?? process.cwd()
  })
  const snapshot = collectDashboardData({
    cwd: options.cwd ?? process.cwd(),
    sessionDir: parsed.sessionDir ?? options.sessionDir,
    auditDir: parsed.auditDir ?? options.auditDir
  })
  const write = options.stdout ?? console.log
  write(`Dashboard running at ${server.url}`)
  write('数据源:')
  write(`- sessions: ${snapshot.dataSources.sessionRoot}`)
  write(`- audit: ${snapshot.dataSources.auditDir}`)
  write(`- evals: ${snapshot.dataSources.evalRunsDir}`)
  write('隐私: 默认只展示摘要/哈希/计数，不上传本地数据。')

  if (parsed.open) openUrl(server.url)
  await waitForStop(server.server)
  return 0
}

/** 启动 Dashboard HTTP 服务。 */
export async function startDashboardServer(options: DashboardServerOptions = {}): Promise<DashboardServerHandle> {
  const host = normalizeDashboardHost(options.host ?? DEFAULT_HOST)
  const requestedPort = options.port ?? DEFAULT_PORT
  const runtimeOptions: DashboardRuntimeOptions = {
    ...options,
    host,
    snapshotCache: {}
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtimeOptions)
  })
  const port = await listenWithFallback(server, host, requestedPort)
  const url = formatDashboardUrl(host, port)
  return {
    server,
    host,
    port,
    url,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      })
  }
}

function parseDashboardArgs(argv: string[]): DashboardServerOptions {
  const host = getStringArg('--host', argv)
  const portArg = getStringArg('--port', argv)
  const sessionDir = getStringArg('--session-dir', argv)
  const auditDir = getStringArg('--audit-dir', argv)
  const open = argv.includes('--open')
  const noOpen = argv.includes('--no-open')
  return {
    ...(host ? { host } : {}),
    ...(portArg ? { port: parsePort(portArg) } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    ...(auditDir ? { auditDir } : {}),
    open: open && !noOpen
  }
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid dashboard port: ${value}`)
  }
  return port
}

function normalizeDashboardHost(host: string): string {
  const trimmed = host.trim()
  const normalized = trimmed === '[::1]' ? '::1' : trimmed
  if (isLoopbackHost(normalized)) return normalized
  throw new Error('Dashboard host must be loopback-only: use 127.0.0.1, localhost, or ::1')
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === 'localhost' || normalized === '::1') return true
  const parts = normalized.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  )
}

function formatDashboardUrl(host: string, port: number): string {
  const urlHost = host.includes(':') ? `[${host.replace(/^\[|\]$/g, '')}]` : host
  return `http://${urlHost}:${port}`
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: DashboardRuntimeOptions
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? DEFAULT_HOST}`)
  try {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    if (url.pathname === '/') {
      sendText(response, 200, renderDashboardHtml(), 'text/html; charset=utf-8')
      return
    }

    if (url.pathname === '/api/dashboard') {
      const snapshot = collectDashboardDataWithCache(options)
      sendJson(response, 200, applySnapshotFilters(snapshot, url.searchParams))
      return
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch?.[1]) {
      const detail = collectDashboardSessionDetail(decodeURIComponent(sessionMatch[1]), {
        ...options,
        cwd: options.cwd ?? process.cwd()
      })
      if (!detail) {
        sendJson(response, 404, { error: 'Session not found' })
        return
      }
      sendJson(response, 200, detail)
      return
    }

    sendJson(response, 404, { error: 'Not found' })
  } catch (error) {
    void error
    sendJson(response, 500, { error: 'Dashboard request failed' })
  }
}

function collectDashboardDataWithCache(options: DashboardRuntimeOptions): DashboardSnapshot {
  const dataOptions = toDashboardDataOptions(options)
  const key = JSON.stringify(dataOptions)
  const now = Date.now()
  const cached = options.snapshotCache.value
  if (cached && cached.key === key && cached.expiresAt > now) return cached.snapshot
  const snapshot = collectDashboardData(dataOptions)
  options.snapshotCache.value = {
    key,
    expiresAt: now + SNAPSHOT_CACHE_TTL_MS,
    snapshot
  }
  return snapshot
}

function toDashboardDataOptions(options: DashboardServerOptions): DashboardDataOptions {
  return {
    cwd: options.cwd ?? process.cwd(),
    ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
    ...(options.auditDir ? { auditDir: options.auditDir } : {}),
    ...(options.sessionLimit !== undefined ? { sessionLimit: options.sessionLimit } : {}),
    ...(options.auditLimit !== undefined ? { auditLimit: options.auditLimit } : {}),
    ...(options.evalLimit !== undefined ? { evalLimit: options.evalLimit } : {})
  }
}

function applySnapshotFilters(snapshot: DashboardSnapshot, params: URLSearchParams): DashboardSnapshot {
  const session = normalizeFilter(params.get('session'))
  const event = normalizeFilter(params.get('event'))
  const tool = normalizeFilter(params.get('tool'))
  const from = normalizeFilter(params.get('from'))
  const to = normalizeFilter(params.get('to'))
  const recentEvents = snapshot.audit.recentEvents.filter((item) => {
    if (session && item.sessionId !== session) return false
    if (event && item.event !== event) return false
    if (tool && item.toolName !== tool) return false
    if (from && item.ts < from) return false
    if (to && item.ts > to) return false
    return true
  })
  return {
    ...snapshot,
    audit: {
      ...snapshot.audit,
      recentEvents
    }
  }
}

function normalizeFilter(value: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  })
  response.end(text)
}

function sendText(response: ServerResponse, statusCode: number, text: string, contentType: string): void {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  })
  response.end(text)
}

function listenWithFallback(server: Server, host: string, requestedPort: number): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    let port = requestedPort
    const tryListen = () => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE' && requestedPort !== 0 && port < requestedPort + 20) {
          port += 1
          tryListen()
          return
        }
        rejectListen(error)
      }
      const onListening = () => {
        server.off('error', onError)
        const address = server.address() as AddressInfo
        resolveListen(address.port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    tryListen()
  })
}

function waitForStop(server: Server): Promise<void> {
  return new Promise((resolveStop) => {
    server.on('close', resolveStop)
    const stop = () => {
      server.close()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

function openUrl(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

function formatDashboardHelp(): string {
  return [
    'q-code dashboard',
    '',
    'Usage:',
    '  q-code dashboard [--host 127.0.0.1] [--port 48888] [--open] [--session-dir <dir>] [--audit-dir <dir>]',
    '',
    '说明:',
    '  本地启动只读 Web Dashboard，读取 session、audit、SubAgent artifact 与 eval artifact。',
    '  默认绑定 127.0.0.1，仅允许 loopback host，并只展示摘要、哈希、计数、token 与成本。'
  ].join('\n')
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>q-code Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: oklch(0.975 0.008 92);
      --surface: oklch(0.995 0.005 92);
      --surface-2: oklch(0.945 0.014 94);
      --ink: oklch(0.22 0.018 85);
      --muted: oklch(0.49 0.018 82);
      --line: oklch(0.86 0.018 88);
      --accent: oklch(0.62 0.12 71);
      --accent-2: oklch(0.54 0.11 164);
      --danger: oklch(0.56 0.16 28);
      --shadow: 0 16px 38px oklch(0.3 0.02 80 / 0.09);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      letter-spacing: 0;
    }

    header {
      padding: 28px 32px 18px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }

    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.15;
    }

    .subhead {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 16px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
    }

    .local {
      color: var(--accent-2);
      font-weight: 700;
    }

    main {
      padding: 22px 32px 40px;
      display: grid;
      gap: 20px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(130px, 1fr));
      gap: 12px;
    }

    .metric {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 15px 16px;
      box-shadow: var(--shadow);
      min-height: 86px;
    }

    .metric strong {
      display: block;
      font-size: 26px;
      line-height: 1.1;
    }

    .metric span {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
      gap: 20px;
      align-items: start;
    }

    section {
      min-width: 0;
    }

    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--surface-2);
    }

    h2 {
      margin: 0;
      font-size: 15px;
      line-height: 1.2;
    }

    .filters {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }

    input {
      width: 160px;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: oklch(0.99 0.004 90);
      color: var(--ink);
      padding: 7px 9px;
      font: inherit;
      font-size: 13px;
    }

    button {
      min-height: 34px;
      border: 1px solid oklch(0.53 0.09 72);
      border-radius: 6px;
      background: var(--accent);
      color: oklch(0.99 0.006 90);
      padding: 7px 11px;
      font: inherit;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    th, td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      background: oklch(0.98 0.006 90);
    }

    tr[data-session-id] {
      cursor: pointer;
    }

    tr[data-session-id]:hover {
      background: oklch(0.965 0.018 93);
    }

    .muted {
      color: var(--muted);
    }

    .danger {
      color: var(--danger);
      font-weight: 700;
    }

    .stack {
      display: grid;
      gap: 20px;
    }

    .detail {
      padding: 14px 16px;
      display: grid;
      gap: 14px;
    }

    .detail h3 {
      margin: 0 0 8px;
      font-size: 13px;
    }

    .timeline {
      display: grid;
      gap: 8px;
      max-height: 360px;
      overflow: auto;
    }

    .timeline-item {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      background: oklch(0.99 0.004 88);
      font-size: 12px;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: oklch(0.36 0.06 164);
    }

    .empty {
      padding: 24px 16px;
      color: var(--muted);
      font-size: 13px;
    }

    @media (max-width: 980px) {
      header, main { padding-left: 18px; padding-right: 18px; }
      .metrics { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
      .layout { grid-template-columns: 1fr; }
      input { width: 100%; flex: 1 1 140px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>q-code Dashboard</h1>
    <div class="subhead">
      <span class="local">Local only</span>
      <span id="generated">loading...</span>
      <span>摘要模式，不渲染 prompt 或工具输出原文</span>
    </div>
  </header>
  <main>
    <div class="metrics" id="metrics"></div>
    <div class="layout">
      <section class="panel">
        <div class="panel-head">
          <h2>Sessions</h2>
          <span class="muted" id="session-count"></span>
        </div>
        <div id="sessions"></div>
      </section>
      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <h2>Audit</h2>
            <span class="muted" id="audit-count"></span>
          </div>
          <div class="filters">
            <input id="filter-session" placeholder="session">
            <input id="filter-event" placeholder="event">
            <input id="filter-tool" placeholder="tool">
            <button id="apply-filters">Filter</button>
          </div>
          <div id="audit"></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Agent Artifacts</h2>
          </div>
          <div id="agents"></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Task Graph</h2>
          </div>
          <div id="tasks"></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Eval Runs</h2>
          </div>
          <div id="evals"></div>
        </section>
      </div>
    </div>
    <section class="panel">
      <div class="panel-head">
        <h2>Session Detail</h2>
        <span class="muted" id="detail-title">选择一条 session 查看详情</span>
      </div>
      <div class="detail" id="detail"></div>
    </section>
  </main>
  <script>
    const state = { snapshot: null };
    const fmt = new Intl.NumberFormat('en-US');

    async function loadDashboard() {
      const params = new URLSearchParams();
      for (const [id, key] of [
        ['filter-session', 'session'],
        ['filter-event', 'event'],
        ['filter-tool', 'tool']
      ]) {
        const value = document.getElementById(id).value.trim();
        if (value) params.set(key, value);
      }
      const response = await fetch('/api/dashboard' + (params.toString() ? '?' + params : ''));
      state.snapshot = await response.json();
      render();
    }

    function render() {
      const data = state.snapshot;
      document.getElementById('generated').textContent = 'generated ' + shortDate(data.generatedAt);
      document.getElementById('metrics').innerHTML = [
        metric('Sessions', data.summary.sessionCount),
        metric('Audit events', data.summary.auditEventCount),
        metric('Tasks', data.summary.taskCount),
        metric('Agents', data.summary.agentArtifactCount),
        metric('Eval runs', data.summary.evalRunCount),
        metric('Tokens', data.summary.totalTokens)
      ].join('');
      renderSessions(data.sessions);
      renderAudit(data.audit.recentEvents);
      renderAgents(data.agents.artifacts);
      renderTasks(data.tasks);
      renderEvals(data.evals.runs, data.evals.trend);
    }

    function metric(label, value) {
      return '<div class="metric"><strong>' + escapeHtml(fmt.format(value || 0)) + '</strong><span>' + escapeHtml(label) + '</span></div>';
    }

    function renderSessions(sessions) {
      document.getElementById('session-count').textContent = sessions.length + ' visible';
      if (!sessions.length) {
        document.getElementById('sessions').innerHTML = '<div class="empty">暂无 session 数据</div>';
        return;
      }
      document.getElementById('sessions').innerHTML = table(
        ['Session', 'Model', 'Tools', 'Tokens', 'Updated'],
        sessions.map((item) => ({
          attrs: ' data-session-id="' + escapeHtml(item.sessionId) + '"',
          cells: [
            '<strong>' + escapeHtml(item.displayName || item.sessionId) + '</strong><br><span class="muted">' + escapeHtml(item.lastUserPromptDigest || item.projectKey) + '</span>',
            escapeHtml(item.model || 'unknown'),
            fmt.format(item.toolCallCount || 0),
            fmt.format(item.totalTokens || 0),
            shortDate(item.updatedAt)
          ]
        }))
      );
      for (const row of document.querySelectorAll('[data-session-id]')) {
        row.addEventListener('click', () => loadSession(row.dataset.sessionId));
      }
    }

    function renderAudit(events) {
      document.getElementById('audit-count').textContent = events.length + ' recent';
      if (!events.length) {
        document.getElementById('audit').innerHTML = '<div class="empty">无匹配审计事件</div>';
        return;
      }
      document.getElementById('audit').innerHTML = table(
        ['Time', 'Event', 'Tool', 'Result'],
        events.slice(0, 50).map((item) => ({
          cells: [
            shortDate(item.ts),
            escapeHtml(item.event) + (item.sessionId ? '<br><code>' + escapeHtml(item.sessionId) + '</code>' : ''),
            escapeHtml(item.toolName || ''),
            item.ok === false || item.isError ? '<span class="danger">error</span>' : '<span class="muted">ok</span>'
          ]
        }))
      );
    }

    function renderAgents(artifacts) {
      if (!artifacts.length) {
        document.getElementById('agents').innerHTML = '<div class="empty">暂无后台 Agent artifact</div>';
        return;
      }
      document.getElementById('agents').innerHTML = table(
        ['Agent', 'Status', 'Tools', 'Tokens'],
        artifacts.slice(0, 12).map((item) => ({
          cells: [
            '<strong>' + escapeHtml(item.agentType || item.agentId) + '</strong><br><code>' + escapeHtml(item.sessionId) + '</code>',
            escapeHtml(item.status),
            fmt.format(item.toolUseCount || 0),
            fmt.format(item.totalTokens || 0)
          ]
        }))
      );
    }

    function renderTasks(graph) {
      if (!graph.tasks.length) {
        document.getElementById('tasks').innerHTML = '<div class="empty">暂无 Task V2 任务图</div>';
        return;
      }
      document.getElementById('tasks').innerHTML = table(
        ['Task', 'Status', 'Blocks'],
        graph.tasks.slice(0, 16).map((item) => ({
          cells: [
            '<strong>#' + escapeHtml(item.taskId) + '</strong><br><code>' + escapeHtml(item.sessionId) + '</code>',
            escapeHtml(item.status),
            escapeHtml(item.blocks.join(', ') || '')
          ]
        }))
      );
    }

    function renderEvals(runs, trend) {
      if (!runs.length) {
        document.getElementById('evals').innerHTML = '<div class="empty">暂无 eval run</div>';
        return;
      }
      const trendLine = trend ? '<div class="empty">Trend: ' + trend.runCount + ' runs, latest pass ' + Math.round((trend.latestPassRate || 0) * 100) + '%</div>' : '';
      document.getElementById('evals').innerHTML = trendLine + table(
        ['Run', 'Pass', 'Score', 'Tokens'],
        runs.slice(0, 12).map((item) => ({
          cells: [
            '<strong>' + escapeHtml(item.suiteName) + '</strong><br><code>' + escapeHtml(item.runId) + '</code>',
            Math.round((item.passRate || 0) * 100) + '%',
            String(Math.round((item.averageScore || 0) * 100) / 100),
            fmt.format(item.totalTokens || 0)
          ]
        }))
      );
    }

    async function loadSession(sessionId) {
      const response = await fetch('/api/sessions/' + encodeURIComponent(sessionId));
      const detail = await response.json();
      document.getElementById('detail-title').textContent = detail.session.displayName || detail.session.sessionId;
      document.getElementById('detail').innerHTML = [
        '<div><h3>Messages</h3><div class="timeline">' + detail.messages.slice(-20).map(renderMessage).join('') + '</div></div>',
        '<div><h3>Tools</h3>' + renderToolTable(detail.tools) + '</div>'
      ].join('');
    }

    function renderMessage(item) {
      return '<div class="timeline-item"><strong>' + escapeHtml(item.role) + '</strong> <span class="muted">' + shortDate(item.timestamp) + '</span><br>' + escapeHtml(item.preview) + '<br><code>' + escapeHtml(item.contentSha256.slice(0, 16)) + '</code></div>';
    }

    function renderToolTable(tools) {
      if (!tools.length) return '<div class="empty">无工具轨迹</div>';
      return table(
        ['Time', 'Phase', 'Tool', 'Result'],
        tools.map((item) => ({
          cells: [
            shortDate(item.timestamp),
            escapeHtml(item.phase),
            escapeHtml(item.name),
            item.isError ? '<span class="danger">error</span>' : escapeHtml(String(item.resultLength || ''))
          ]
        }))
      );
    }

    function table(headers, rows) {
      return '<table><thead><tr>' + headers.map((item) => '<th>' + escapeHtml(item) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr' + (row.attrs || '') + '>' + row.cells.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    }

    function shortDate(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char]));
    }

    document.getElementById('apply-filters').addEventListener('click', loadDashboard);
    loadDashboard().catch((error) => {
      document.body.innerHTML = '<main><section class="panel"><div class="empty">' + escapeHtml(error.message) + '</div></section></main>';
    });
  </script>
</body>
</html>`
}

/** 将 Dashboard API 中的路径按 cwd 缩短，供测试或未来 UI 使用。 */
export function shortDashboardPath(filePath: string, cwd: string = process.cwd()): string {
  return formatDashboardPath(resolve(filePath), resolve(cwd))
}
