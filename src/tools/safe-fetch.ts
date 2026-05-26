/**
 * 面向 Agent 的安全 HTTP 抓取：校验公网 URL、跟随有限次重定向并拒绝私网地址。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const MAX_REDIRECTS = 5

/**
 * 在每次重定向前重新校验目标 URL，使用 manual redirect 防止 SSRF 跳转绕过。
 */
export async function safeFetchUrl(
  rawUrl: string,
  init: RequestInit = {},
  options: { maxRedirects?: number } = {}
): Promise<Response> {
  let current = await validatePublicHttpUrl(rawUrl)
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetch(current, {
      ...init,
      redirect: 'manual'
    })

    if (!isRedirect(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response
    if (redirects === maxRedirects) {
      throw new Error(`重定向次数超过上限 ${maxRedirects}`)
    }
    current = await validatePublicHttpUrl(new URL(location, current).toString())
  }

  throw new Error(`重定向次数超过上限 ${maxRedirects}`)
}

/**
 * 解析并校验 URL 为 http(s) 且 hostname 解析结果均为公网地址。
 * @returns 规范化后的 URL 字符串
 */
export async function validatePublicHttpUrl(rawUrl: string): Promise<string> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('URL 格式无效')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅允许 http:// 或 https:// URL')
  }
  const hostname = normalizeHostname(url.hostname)
  if (!hostname) throw new Error('URL 缺少 hostname')
  if (isLocalHostname(hostname)) {
    throw new Error(`拒绝访问本地地址: ${hostname}`)
  }

  const addresses = await resolveHostname(hostname)
  for (const address of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(`拒绝访问非公网地址: ${address}`)
    }
  }

  return url.toString()
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const literalType = isIP(hostname)
  if (literalType !== 0) return [hostname]

  const records = await lookup(hostname, { all: true, verbatim: true })
  if (records.length === 0) throw new Error(`无法解析 hostname: ${hostname}`)
  return records.map((record) => record.address)
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized === 'localhost' || normalized.endsWith('.localhost')
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)]$/, '$1')
}

function isPrivateOrReservedIp(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPrivateOrReservedIpv4(address)
  if (version === 6) return isPrivateOrReservedIpv6(address)
  return true
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }
  const [a, b] = parts

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  )
}

function isPrivateOrReservedIpv6(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('2001:db8:')) return true

  const first = parseInt(normalized.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xff00) === 0xff00) return true

  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateOrReservedIpv4(mapped[1])

  return false
}
