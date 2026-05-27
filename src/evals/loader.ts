/**
 * Eval case loader：从 evals 目录下的 json/yaml/yml 文件读取固定任务集。
 */
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import fg from 'fast-glob'
import YAML from 'yaml'
import type { EvalCase, EvalSuiteFile, LoadedEvalCases } from './types'

/** 从路径列表加载 eval cases；未传路径时默认读取 `evals/smoke`。 */
export async function loadEvalCases(paths: string[] = ['evals/smoke'], cwd: string = process.cwd()): Promise<LoadedEvalCases> {
  const sources = await resolveEvalSources(paths, cwd)
  const cases: EvalCase[] = []
  const suiteNames = new Set<string>()

  for (const source of sources) {
    const suite = await readEvalSuite(source)
    if (suite.suite) suiteNames.add(suite.suite)
    for (const caseDef of suite.cases) {
      cases.push(normalizeEvalCase(caseDef, source))
    }
  }

  if (cases.length === 0) {
    throw new Error(`未找到 eval case: ${paths.join(', ')}`)
  }

  return {
    suiteName: suiteNames.size === 1 ? Array.from(suiteNames)[0]! : inferSuiteName(paths),
    cases,
    sources
  }
}

/** 解析可执行的 eval 文件来源。 */
export async function resolveEvalSources(paths: string[], cwd: string): Promise<string[]> {
  const files = new Set<string>()
  for (const rawPath of paths) {
    const absolute = resolve(cwd, rawPath)
    if (!existsSync(absolute)) {
      const matches = await fg(rawPath, {
        cwd,
        absolute: true,
        onlyFiles: true,
        dot: false
      })
      for (const match of matches.filter(isEvalFile)) files.add(resolve(match))
      continue
    }
    const stat = statSync(absolute)
    if (stat.isDirectory()) {
      const matches = await fg(['**/*.json', '**/*.yaml', '**/*.yml'], {
        cwd: absolute,
        absolute: true,
        onlyFiles: true,
        dot: false
      })
      for (const match of matches) files.add(resolve(match))
    } else if (stat.isFile() && isEvalFile(absolute)) {
      files.add(absolute)
    }
  }
  return Array.from(files).sort((a, b) => a.localeCompare(b))
}

async function readEvalSuite(filePath: string): Promise<EvalSuiteFile> {
  const raw = await readFile(filePath, 'utf-8')
  const ext = extname(filePath).toLowerCase()
  const parsed = ext === '.json' ? JSON.parse(raw) : YAML.parse(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${filePath}: eval suite 必须是对象`)
  }
  if (!Array.isArray((parsed as EvalSuiteFile).cases)) {
    throw new Error(`${filePath}: 缺少 cases 数组`)
  }
  return parsed as EvalSuiteFile
}

function normalizeEvalCase(caseDef: EvalCase, source: string): EvalCase {
  assertText(caseDef.id, source, 'id')
  assertText(caseDef.name, source, 'name')
  assertText(caseDef.prompt, source, 'prompt')
  if (caseDef.mode !== 'mock-agent' && caseDef.mode !== 'cli-subprocess' && caseDef.mode !== 'real-agent') {
    throw new Error(`${source}:${caseDef.id}: 不支持 mode=${caseDef.mode}`)
  }
  if (caseDef.mode === 'mock-agent' && (!caseDef.mock || !Array.isArray(caseDef.mock.turns))) {
    throw new Error(`${source}:${caseDef.id}: mock.turns 必须是数组`)
  }
  if (caseDef.mode === 'cli-subprocess' && (!caseDef.cli || !caseDef.cli.command)) {
    throw new Error(`${source}:${caseDef.id}: cli.command 必须是非空字符串`)
  }
  if (caseDef.mode === 'real-agent' && !caseDef.real) {
    throw new Error(`${source}:${caseDef.id}: real 配置缺失；真实模型 eval 必须显式声明 real`)
  }
  return {
    ...caseDef,
    tags: Array.isArray(caseDef.tags) ? caseDef.tags : [],
    system: caseDef.system ?? 'You are q-code eval mock agent.',
    expect: caseDef.expect ?? {}
  }
}

function assertText(value: unknown, source: string, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${source}: case.${field} 必须是非空字符串`)
  }
}

function isEvalFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return ext === '.json' || ext === '.yaml' || ext === '.yml'
}

function inferSuiteName(paths: string[]): string {
  if (paths.length === 1) return basename(paths[0]) || 'eval'
  return 'mixed'
}
