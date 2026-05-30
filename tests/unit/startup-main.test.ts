import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const itIfSubprocessAvailable = canExecNodeSubprocesses() ? it : it.skip

describe('startup main', () => {
  itIfSubprocessAvailable('does not create a persisted session when dumping the system prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-dump-system-prompt-'))
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    const qcodeHome = join(root, 'qcode-home')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(qcodeHome, { recursive: true })

    try {
      const repoRoot = process.cwd()
      const output = execFileSync(
        process.execPath,
        [
          join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
          join(repoRoot, 'src/index.ts'),
          '--dump-system-prompt',
        ],
        {
          cwd,
          encoding: 'utf-8',
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            SystemRoot: process.env.SystemRoot,
            HOME: home,
            USERPROFILE: home,
            NO_COLOR: '1',
            CI: '1',
            OPENAI_API_KEY: 'dummy',
            OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
            OPENAI_MODEL: 'test-model',
            SUMMARY_API_KEY: 'dummy',
            SUMMARY_BASE_URL: 'http://127.0.0.1:9/v1',
            SUMMARY_MODEL: 'test-model',
            Q_CODE_HOME: qcodeHome,
            Q_CODE_SESSION_DIR: '.sessions',
            Q_CODE_AUDIT_ENABLED: 'false',
            Q_CODE_CRASH_GUARD: 'false',
            Q_CODE_HISTORY_DISABLED: 'true',
            Q_CODE_INFRA_ENABLED: 'false',
            Q_CODE_INFRA_SYNC: 'false',
            Q_CODE_LANGFUSE_ENABLED: 'false',
            Q_CODE_GITLAB_KB_ENABLED: 'false',
            MCP_CONNECT_TIMEOUT_MS: '100',
          },
        },
      )

      expect(output).toContain('你是 q-code')

      const sessionFiles = collectFiles(join(cwd, '.sessions'))
      expect(
        sessionFiles.filter(
          (file) =>
            file.endsWith('.jsonl') ||
            file.endsWith('.meta.json') ||
            file === 'latest' ||
            file.endsWith('/latest'),
        ),
      ).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  itIfSubprocessAvailable('dumped system prompt is stable across consecutive runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'q-code-dump-system-prompt-stable-'))
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    const qcodeHome = join(root, 'qcode-home')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(qcodeHome, { recursive: true })

    try {
      const first = dumpSystemPrompt({ cwd, home, qcodeHome })
      const second = dumpSystemPrompt({ cwd, home, qcodeHome })

      expect(first).toBe(second)
      expect(first).not.toMatch(/当前日期: \d{4}-\d{2}-\d{2}T/u)
      expect(first).toContain('你是 q-code')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function dumpSystemPrompt(options: { cwd: string; home: string; qcodeHome: string }): string {
  const repoRoot = process.cwd()
  return execFileSync(
    process.execPath,
    [
      join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
      join(repoRoot, 'src/index.ts'),
      '--dump-system-prompt',
    ],
    {
      cwd: options.cwd,
      encoding: 'utf-8',
      env: {
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
        OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
        OPENAI_MODEL: 'test-model',
        SUMMARY_API_KEY: 'dummy',
        SUMMARY_BASE_URL: 'http://127.0.0.1:9/v1',
        SUMMARY_MODEL: 'test-model',
        Q_CODE_HOME: options.qcodeHome,
        Q_CODE_SESSION_DIR: '.sessions',
        Q_CODE_AUDIT_ENABLED: 'false',
        Q_CODE_CRASH_GUARD: 'false',
        Q_CODE_HISTORY_DISABLED: 'true',
        Q_CODE_INFRA_ENABLED: 'false',
        Q_CODE_INFRA_SYNC: 'false',
        Q_CODE_LANGFUSE_ENABLED: 'false',
        Q_CODE_GITLAB_KB_ENABLED: 'false',
        Q_CODE_CHANGELOG: '0',
        MCP_CONNECT_TIMEOUT_MS: '100',
      },
    },
  )
}

function canExecNodeSubprocesses(): boolean {
  try {
    const repoRoot = process.cwd()
    execFileSync(
      process.execPath,
      [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), '-e', 'process.exit(0)'],
      { stdio: 'ignore' },
    )
    return true
  } catch {
    return false
  }
}

function collectFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  collectFilesInto(root, root, files)
  return files.sort()
}

function collectFilesInto(root: string, dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFilesInto(root, fullPath, files)
      continue
    }
    files.push(relative(root, fullPath).split('\\').join('/'))
  }
}
