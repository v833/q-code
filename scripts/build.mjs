import { copyFile, chmod, mkdir, rm } from 'node:fs/promises'
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
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  banner: {
    js: '#!/usr/bin/env node'
  }
})

await chmod('dist/index.js', 0o755)

if (existsSync(CHANGELOG_JSON)) {
  await copyFile(CHANGELOG_JSON, join(ROOT, 'dist/changelog.json'))
}
