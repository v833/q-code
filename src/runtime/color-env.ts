/**
 * 终端着色环境：解析 `--no-color` 等 CLI 标志并写入 `NO_COLOR` / `FORCE_COLOR`。
 */

/** 可被 {@link applyNoColorEnvironment} 修改的进程环境子集。 */
export interface ColorEnvironment {
  NO_COLOR?: string | undefined;
  FORCE_COLOR?: string | undefined;
}

const NO_COLOR_FLAGS = new Set(['--no-color', '--no-colors', '--color=false', '--color=never']);

/**
 * 若 argv 含无颜色标志且未显式设置 `NO_COLOR`，则写入 `NO_COLOR=1` 并强制 `FORCE_COLOR=0`。
 *
 * @param argv - 待扫描的命令行参数，默认 `process.argv`。
 * @param env - 目标环境对象，默认 `process.env`。
 */
export function applyNoColorEnvironment(
  argv: readonly string[] = process.argv,
  env: ColorEnvironment = process.env,
): void {
  const hasNoColorFlag = argv.some((arg) => NO_COLOR_FLAGS.has(arg));
  if (hasNoColorFlag && env.NO_COLOR === undefined) {
    env.NO_COLOR = '1';
  }

  if (hasNoColorFlag || env.NO_COLOR !== undefined) {
    env.FORCE_COLOR = '0';
  }
}
