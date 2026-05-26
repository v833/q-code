/**
 * CLI 启动阶段共用的环境变量与 argv 解析、终端展示辅助函数。
 */

/**
 * 读取正数环境变量；支持千分位式下划线（如 `256_000`）。
 *
 * @param name - 环境变量名
 * @param fallback - 未设置或为空时的默认值
 * @throws 值非正有限数时
 */
export function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback

  const value = Number(raw.replace(/_/g, ''))
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
  return value
}

/**
 * 读取 (0,1) 区间比例；可写小数 `0.85` 或百分数 `85`。
 *
 * @throws 结果不在 (0,1) 时
 */
export function getRatioEnv(name: string, fallback: number): number {
  const value = getNumberEnv(name, fallback)
  const ratio = value > 1 && value <= 100 ? value / 100 : value
  if (ratio <= 0 || ratio >= 1) {
    throw new Error(`${name} must be a ratio like 0.85 or a percent like 85`)
  }
  return ratio
}

/**
 * 从 `process.argv` 解析 `--name value` 或 `--name=value`。
 *
 * @param name - 完整开关名，如 `--session`
 */
export function getStringArg(name: string): string | undefined {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1).trim() || undefined

  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) return undefined
  return value.trim() || undefined
}

/** 将未知错误转为用户可见字符串（优先 `Error.message`）。 */
export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 移除 ANSI 转义序列（日志/宽度计算用）。 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

/**
 * 截断过长字符串或 JSON，避免 Ink 终端渲染超大工具输出。
 *
 * @param maxChars - 保留字符上限，默认 2000
 */
export function previewTerminalValue(value: unknown, maxChars = 2000): unknown {
  if (typeof value === 'string') return truncateTerminalText(value, maxChars)
  try {
    return truncateTerminalText(JSON.stringify(value, null, 2), maxChars)
  } catch {
    return truncateTerminalText(String(value), maxChars)
  }
}

function truncateTerminalText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, Math.floor(maxChars * 0.4))
  const tail = text.slice(-(maxChars - head.length))
  return `${head}\n... clipped ${text.length - maxChars} chars for terminal ...\n${tail}`
}
