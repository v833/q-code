import { readFile, writeFile } from 'node:fs/promises'

const inputPath = new URL('./input.txt', import.meta.url)
const before = await readFile(inputPath, 'utf-8')
await writeFile(inputPath, `${before.trim()}\nstatus: complete\n`, 'utf-8')
console.log('updated input.txt')
