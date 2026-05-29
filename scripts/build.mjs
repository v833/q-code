import { copyFile, chmod, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { build } from 'esbuild'

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

if (existsSync('changelog.json')) {
  await copyFile('changelog.json', 'dist/changelog.json')
}
