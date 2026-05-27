/**
 * CLI / 经典 readline 模式的终端彩色与格式化输出。
 *
 * 在 TTY 下使用 ANSI 转义着色；非 TTY（管道、CI）自动降级为纯文本。
 * Ink TUI 路径通常不依赖本模块。
 */
const isColorSupported = process.stdout.isTTY

/** 用 ANSI 转义序列包裹文本，非 TTY 环境自动跳过着色 */
function wrap(code: number) {
  return (text: string) => (isColorSupported ? `\x1b[${code}m${text}\x1b[0m` : text)
}

/** ANSI 颜色与样式快捷函数集合（bold、dim、red 等） */
export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
  bgBlue: wrap(44)
}

const S = {
  arrow: '→',
  check: '✔',
  cross: '✖',
  bullet: '•',
  dot: '·',
  dash: '─',
  cornerTL: '╭',
  cornerBL: '╰',
  cornerTR: '╮',
  cornerBR: '╯',
  pipe: '│'
}

/** 绘制带圆角的标题行，如 "╭─ Step 1 ───────────────╮" */
export function boxedTitle(text: string, width = 50): string {
  const inner = ` ${text} `
  const pad = Math.max(0, width - inner.length - 2)
  return `${S.cornerTL}${S.dash}${inner}${S.dash.repeat(pad)}${S.cornerTR}`
}

/** 绘制底部圆角行 */
export function boxedBottom(width = 50): string {
  return `${S.cornerBL}${S.dash.repeat(width)}${S.cornerBR}`
}

/** 格式化工具调用行 */
export function fmtToolCall(name: string, input: unknown): string {
  const inputStr = JSON.stringify(input)
  const display = inputStr.length > 60 ? inputStr.slice(0, 57) + '...' : inputStr
  return `${c.cyan(S.arrow)} ${c.bold(name)} ${c.gray(display)}`
}

/** 格式化工具结果行 */
export function fmtToolResult(output: unknown): string {
  const str = JSON.stringify(output)
  const display = str.length > 80 ? str.slice(0, 77) + '...' : str
  return `${c.green(S.check)} ${c.gray(display)}`
}

/** 格式化锁获取信息 */
export function fmtLockAcquire(name: string, shared: boolean): string {
  if (shared) {
    return `  ${c.blue(S.bullet)} ${c.dim(name)} 获取共享锁`
  }
  return `  ${c.yellow(S.bullet)} ${c.dim(name)} 获取独占锁`
}

/** 格式化重试信息 */
export function fmtRetry(attempt: number, max: number, delay: number): string {
  return `  ${c.yellow(S.arrow)} 重试 ${c.bold(`${attempt}/${max}`)} ${c.dim(`${delay}ms 后`)}`
}

/** 格式化模型输出触顶后的升级重试提示 */
export function fmtOutputRetry(fromTokens: number, toTokens: number): string {
  return `\n  ${c.yellow(S.arrow)} 输出达到 ${fromTokens} tokens 上限，升级到 ${toTokens} tokens 重试`
}

/** 格式化上下文占用 */
export function fmtContextUsage(used: number, limit: number, state = 'normal'): string {
  const pct = Math.round((used / limit) * 100)
  const barLen = 12
  const filled = Math.min(barLen, Math.round((pct / 100) * barLen))
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)
  const color = state === 'blocking' || state === 'error' ? c.red : state === 'warning' ? c.yellow : c.green
  const label = state === 'normal' ? '' : c.dim(` ${state}`)
  return `  ${c.gray('上下文')} ${color(bar)} ${c.bold(`${used}`)}/${limit} ${c.dim(`(${pct}%)`)}${label}`
}

/** 格式化首 Token 时间 (TTFT) */
export function fmtTTFT(ms: number): string {
  const color = ms < 500 ? c.green : ms < 1500 ? c.yellow : c.red
  const display = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
  return `${c.gray('TTFT')} ${color(display)}`
}

/** 格式化每秒输出 Token 数 (TPS) */
export function fmtTPS(tokensPerSec: number): string {
  const color = tokensPerSec >= 50 ? c.green : tokensPerSec >= 20 ? c.yellow : c.red
  return `${c.gray('TPS')} ${color(c.bold(tokensPerSec.toFixed(1)))}${c.dim('/s')}`
}

/** 格式化步骤性能指标（TTFT + TPS 一行输出） */
export function fmtStepPerf(ttftMs: number, tps: number): string {
  return `  ${fmtTTFT(ttftMs)}  ${fmtTPS(tps)}`
}

/** 格式化循环检测警告 */
export function fmtLoopWarning(message: string, level: 'warning' | 'critical'): string {
  if (level === 'critical') {
    return `  ${c.red(S.cross)} ${c.red(c.bold(message))}`
  }
  return `  ${c.yellow('⚠')} ${c.yellow(message)}`
}

/** 格式化停止原因 */
export function fmtStop(reason: string): string {
  return `\n${c.red(S.cross)} ${c.red(reason)}`
}

/** 格式化"继续下一步" */
export function fmtContinue(): string {
  return `  ${c.dim(`${S.arrow} 继续下一步...`)}`
}

/** 格式化步骤标题 */
export function fmtStepHeader(step: number): string {
  return `\n${c.bold(c.blue(boxedTitle(`Step ${step}`)))}`
}

/** 格式化步骤底部 */
export function fmtStepFooter(): string {
  return c.blue(boxedBottom())
}

/** 启动横幅 */
export function fmtBanner(version: string): string {
  const lines = [
    c.bold(c.cyan('  ╦╔═╔═╗╦  ╔═╗')),
    c.bold(c.cyan('  ╠╩╗║ ║║  ║ ║')),
    c.bold(c.cyan('  ╩ ╩╚═╝╩═╝╚═╝')),
    '',
    `  ${c.gray('q code')} ${c.dim(`v${version}`)}  ${c.gray('·')}  ${c.dim('type "exit" to quit')}`
  ]
  return lines.join('\n')
}

/** 格式化工具注册表列表 */
export function fmtToolList(
  tools: Array<{ name: string; isConcurrencySafe?: boolean; isReadOnly?: boolean }>
): string {
  const lines = tools.map((t) => {
    const flags: string[] = []
    flags.push(t.isConcurrencySafe ? c.green('并发') : c.yellow('串行'))
    flags.push(t.isReadOnly ? c.blue('只读') : c.red('读写'))
    return `  ${c.gray(S.dot)} ${c.bold(t.name).padEnd(14)} ${c.dim(`[${flags.join(c.dim(','))}]`)}`
  })
  return `${c.gray(`已注册 ${tools.length} 个工具`)}\n${lines.join('\n')}`
}

/** 格式化任务总耗时 */
export function fmtTaskDuration(ms: number): string {
  let display: string
  if (ms < 1000) {
    display = `${ms}ms`
  } else if (ms < 60000) {
    display = `${(ms / 1000).toFixed(1)}s`
  } else {
    const min = Math.floor(ms / 60000)
    const sec = ((ms % 60000) / 1000).toFixed(1)
    display = `${min}m${sec}s`
  }
  return `\n  ${c.gray('⏱')} ${c.gray('总耗时')} ${c.bold(c.cyan(display))}`
}

/** 格式化用户提示符 */
export function fmtPrompt(): string {
  return `\n${c.bold(c.green('You: '))}`
}
