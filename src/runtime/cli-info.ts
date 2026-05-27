/**
 * 早期 CLI 子命令路由与版本/帮助文案（不启动 MCP 与会话）。
 *
 * `getEarlyCliCommand` 在 `index.ts` 进入主循环前 short-circuit：
 * help、version、update、audit、init、eval。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 在进入主交互循环前即可处理的子命令。 */
export type EarlyCliCommand = 'help' | 'version' | 'update' | 'audit' | 'init' | 'eval'

let cachedPackageVersion: string | undefined

/**
 * 解析 `@q-code-cli/q-code` 的 package.json 版本（向上遍历至多 6 层目录）。
 *
 * 找不到时回退 `npm_package_version` 或 `0.0.0`；结果进程内缓存。
 */
export function getPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion

  const startDir = dirname(fileURLToPath(import.meta.url))
  for (const filePath of getPackageJsonCandidates(startDir)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
        name?: unknown
        version?: unknown
      }
      if (parsed.name === '@q-code-cli/q-code' && typeof parsed.version === 'string') {
        cachedPackageVersion = parsed.version
        return cachedPackageVersion
      }
    } catch {
      // Keep walking; --version should never fail because package metadata is unavailable.
    }
  }

  cachedPackageVersion = process.env.npm_package_version?.trim() || '0.0.0'
  return cachedPackageVersion
}

/**
 * 根据 argv（不含 node/q-code 可执行路径）判断早期子命令。
 *
 * `--help` / `-h` 与 `help` 均映射为 `help`；`--version` / `-v` 同理。
 */
export function getEarlyCliCommand(argv: string[]): EarlyCliCommand | undefined {
  const first = argv[0]
  if (first === 'help' || argv.includes('--help') || argv.includes('-h')) return 'help'
  if (first === 'version' || argv.includes('--version') || argv.includes('-v')) return 'version'
  if (first === 'update') return 'update'
  if (first === 'audit') return 'audit'
  if (first === 'init') return 'init'
  if (first === 'eval') return 'eval'
  return undefined
}

/** 格式化单行版本输出，如 `q-code 1.2.3`。 */
export function formatCliVersion(version: string): string {
  return `q-code ${version}`
}

/** 生成 `q-code help` 的完整多行帮助文本。 */
export function formatCliHelp(version: string): string {
  return [
    formatCliVersion(version),
    '',
    'Usage:',
    '  q-code [options]',
    '  q-code help',
    '  q-code version',
    '  q-code update [--dry-run]',
    '  q-code audit verify [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
    '  q-code audit tail [--session <id>] [--event <name>] [--follow]',
    '  q-code init [--user|-u] [--local|-l]',
    '  q-code eval list [path...]',
    '  q-code eval run [path...] [--tag <tag>] [--mode <mode>] [--max-cases N] [--max-cost-usd N] [--repeat N] [--concurrency N] [--report json,md,junit] [--out <dir>]',
    '                  [--allow-real-model] [--judge] [--langfuse-datasets]',
    '  q-code eval compare <baseline-name|baseline-run> <candidate-run>',
    '  q-code eval promote <run-dir|run.json> --as <baseline-name>',
    '  q-code eval trend [--suite <name>] [--limit N]',
    '',
    'Options:',
    '  -h, --help                Show help and exit',
    '  -v, --version             Show version and exit',
    '      update                Update global q-code CLI to npm latest',
    '      update --dry-run      Show the update command without running it',
    '      audit verify          Verify local NDJSON audit logs',
    '      audit tail            Print local audit records with optional filters',
    '      init                  Interactive config.toml setup wizard',
    '      init --local          Write config to ./.q-code/config.toml',
    '      init --user           Write config to ~/.q-code/config.toml (default)',
    '      eval list             List eval suites and cases',
    '      eval run              Run deterministic Agent evals and write reports',
    '      eval compare          Compare two eval runs',
    '      eval promote          Save a run as a named local baseline',
    '      eval trend            Build local trend dashboard from eval runs',
    '      --continue            Resume the latest session for this project',
    '      --session <id>        Use a specific session id',
    '      --plan                Start directly in Plan Mode',
    '      --agent-teams         Enable Agent Teams',
    '      --classic             Use the classic readline UI',
    '      --no-color            Disable ANSI highlighting and color output',
    '      --debug               Show startup diagnostics in the terminal',
    '      --dump-system-prompt  Print the full system prompt and exit',
    '',
    'Configuration:',
    '  ~/.q-code/config.toml     Global config',
    '  .q-code/config.toml       Project config',
    '  .env                      Project env fallback',
    '',
    'Examples:',
    '  q-code',
    '  q-code --continue',
    '  q-code --session my-task --plan',
    '  q-code update'
  ].join('\n')
}

/**
 * 是否启用启动诊断（`--debug` 或 `Q_CODE_DEBUG` 为真值字符串）。
 */
export function isDebugMode(
  argv: string[],
  env: { Q_CODE_DEBUG?: string | undefined } = process.env
): boolean {
  return argv.includes('--debug') || isTruthyEnv(env.Q_CODE_DEBUG)
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function getPackageJsonCandidates(startDir: string): string[] {
  const candidates: string[] = []
  let current = startDir

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) candidates.push(candidate)

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return candidates
}
