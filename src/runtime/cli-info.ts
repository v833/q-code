import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type EarlyCliCommand = 'help' | 'version' | 'update' | 'audit'

let cachedPackageVersion: string | undefined

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

export function getEarlyCliCommand(argv: string[]): EarlyCliCommand | undefined {
  const first = argv[0]
  if (first === 'help' || argv.includes('--help') || argv.includes('-h')) return 'help'
  if (first === 'version' || argv.includes('--version') || argv.includes('-v')) return 'version'
  if (first === 'update') return 'update'
  if (first === 'audit') return 'audit'
  return undefined
}

export function formatCliVersion(version: string): string {
  return `q-code ${version}`
}

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
    '',
    'Options:',
    '  -h, --help                Show help and exit',
    '  -v, --version             Show version and exit',
    '      update                Update global q-code CLI to npm latest',
    '      update --dry-run      Show the update command without running it',
    '      audit verify          Verify local NDJSON audit logs',
    '      audit tail            Print local audit records with optional filters',
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
