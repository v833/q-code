/**
 * 通用运行时工具：必填环境变量读取与 OpenAI 兼容 base URL 规范化。
 *
 * `isFalseEnv` 从 `./env` 再导出，供审计、功能开关等模块复用。
 */

/**
 * 读取必填环境变量；缺失时抛出带配置示例的错误。
 *
 * @param name - 环境变量名（如 `OPENAI_API_KEY`）
 * @returns 去首尾空白后的非空字符串
 * @throws 变量未设置或为空时
 */
export function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(
      [
        `Missing required configuration: ${name}`,
        'Set it in the environment, project .env, project .q-code/config.toml, or ~/.q-code/config.toml.',
        'Example:',
        '[openai]',
        'api_key = "sk-..."',
        'base_url = "https://api.openai.com/v1"',
        'model = "gpt-5.4"'
      ].join('\n')
    )
  }

  return value
}

/**
 * 规范化 OpenAI 兼容 API 的 base URL：空 path 补 `/v1`，去掉末尾斜杠。
 *
 * @param rawBaseURL - 配置中的原始 base URL
 * @returns 可用于 SDK 的 base URL 字符串
 * @throws `rawBaseURL` 不是合法 URL 时
 */
export function normalizeBaseURL(rawBaseURL: string) {
  const url = new URL(rawBaseURL)

  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/v1'
  }

  return url.toString().replace(/\/$/, '')
}

export { isFalseEnv } from './env'
