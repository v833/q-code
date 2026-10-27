import { copyFile, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG_JSON = join(ROOT, 'changelog.json')

function generateChangelog() {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts/generate-changelog.mjs')],
    { cwd: ROOT, stdio: 'inherit' }
  )
  if (result.status === 0) return
  if (existsSync(CHANGELOG_JSON)) {
    console.warn('changelog 生成失败，使用已有的 changelog.json 继续构建。')
    return
  }
  process.exit(result.status ?? 1)
}

generateChangelog()

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })

await build({
  entryPoints: {
    index: 'src/cli/bootstrap.ts',
    'sdk/index': 'src/sdk/index.ts'
  },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  chunkNames: 'chunks/[name]-[hash]'
})

const entryPath = join(ROOT, 'dist/index.js')
const entryCode = await readFile(entryPath, 'utf-8')
if (!entryCode.startsWith('#!')) {
  await writeFile(entryPath, `#!/usr/bin/env node\n${entryCode}`)
}
await chmod('dist/index.js', 0o755)

const tscResult = spawnSync(
  process.execPath,
  [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  { cwd: ROOT, stdio: 'inherit' }
)
if (tscResult.status !== 0) process.exit(tscResult.status ?? 1)

if (existsSync(CHANGELOG_JSON)) {
  await copyFile(CHANGELOG_JSON, join(ROOT, 'dist/changelog.json'))
}
