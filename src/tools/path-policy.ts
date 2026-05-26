/**
 * 文件类工具的路径策略：默认限制在当前 cwd 内，可通过环境变量放开。
 */
import { isAbsolute, relative, resolve } from 'node:path'

const ALLOW_OUTSIDE_CWD_ENV = 'Q_CODE_ALLOW_OUTSIDE_CWD'

/**
 * 将用户输入路径解析为绝对路径，并在默认策略下拒绝跳出 cwd。
 * @throws 路径越界且未设置 `Q_CODE_ALLOW_OUTSIDE_CWD`
 */
export function resolveToolPath(cwd: string, inputPath: string): string {
  const root = resolve(cwd)
  const resolved = resolve(root, inputPath)
  if (isOutsideCwdAllowed() || isInsideDirectory(root, resolved)) return resolved

  throw new Error(
    `路径越界: ${inputPath} 不在当前工作目录内。若确实需要访问仓库外路径，请设置 ${ALLOW_OUTSIDE_CWD_ENV}=1。`
  )
}

/** 判断 target 是否位于 root 目录树内（含 root 自身）。 */
export function isInsideDirectory(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isOutsideCwdAllowed(): boolean {
  const value = process.env[ALLOW_OUTSIDE_CWD_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}
