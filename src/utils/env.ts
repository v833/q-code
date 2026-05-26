/**
 * 环境变量布尔“关闭”判定工具。
 *
 * 将 `0`、`false`、`off`、`no`（大小写不敏感）视为显式关闭；
 * 未设置或其它值不视为 false。
 */

/**
 * 判断环境变量值是否表示显式关闭。
 *
 * @param value - 原始环境变量字符串；`undefined` 视为未关闭
 * @returns 值为 `0` / `false` / `off` / `no` 时返回 `true`
 */
export function isFalseEnv(value: string | undefined): boolean {
  return ['0', 'false', 'off', 'no'].includes((value ?? '').trim().toLowerCase())
}

export function isTrueEnv(value: string | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes((value ?? '').trim().toLowerCase())
}
