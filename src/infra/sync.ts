/**
 * 企业 AI 基建配置同步编排。
 *
 * 调用管理端解析配置包，按 checksum 跳过未变化包，落地 MCP/规则/Skills 并更新本地状态。
 */
import { InfraApiClient } from './client'
import { loadInfraConfig, loadInfraUserInfo } from './config'
import { collectRepoInfo } from './git-info'
import { readInfraState, writeInfraState } from './state'
import { applyInfraConfigPackage } from './writers'
import type { InfraConfig, InfraSkillPackage, InfraState, InfraSyncResult } from './types'

/**
 * 与 Infra 管理端同步企业配置包并写入项目 `.q-code`。
 *
 * @param cwd - 项目工作目录
 * @param options.force - 为 true 时即使 checksum 未变也重新下载 Skills 并落地
 * @returns 同步结果（含最终状态与用户可读 message）
 */
export async function syncInfraConfig(cwd: string, options: { force?: boolean } = {}): Promise<InfraSyncResult> {
  const config = loadInfraConfig()
  const now = new Date().toISOString()

  if (!config.enabled) {
    const state: InfraState = {
      clientId: config.clientId,
      enabled: false,
      status: 'disabled',
      lastSyncAt: now,
    }
    return {
      status: 'disabled',
      state,
      message: '企业 AI 基建未启用：设置 Q_CODE_INFRA_ENABLED=true 后才会同步企业配置',
      usedCache: false,
      wroteConfig: false
    }
  }

  const previous = await readInfraState(cwd)
  const repo = await collectRepoInfo(cwd)

  try {
    if (!config.baseUrl || !config.token) {
      throw new Error('已启用企业 AI 基建，但缺少 Q_CODE_INFRA_BASE_URL 或 Q_CODE_INFRA_TOKEN')
    }
    const client = new InfraApiClient(config)
    const response = await client.resolveConfig({
      client: {
        id: config.clientId,
        version: '1.0.0',
        platform: process.platform,
        shell: process.env.SHELL ?? process.env.ComSpec
      },
      user: loadInfraUserInfo(),
      repo,
      currentState: previous
        ? {
            packageId: previous.packageId,
            version: previous.version,
            checksum: previous.checksum
          }
        : undefined
    })

    if (!response.matched || !response.configPackage) {
      const state: InfraState = {
        clientId: config.clientId,
        enabled: true,
        status: 'failed',
        lastSyncAt: now,
        lastError: '未匹配到企业配置包',
        repo
      }
      await writeInfraState(cwd, state)
      return {
        status: 'failed',
        state,
        message: '未匹配到企业配置包',
        usedCache: false,
        wroteConfig: false
      }
    }

    const pkg = response.configPackage
    const unchanged = !options.force && previous?.checksum === pkg.checksum
    const skills = unchanged ? [] : await downloadSkills(config, client, pkg.skills ?? [])
    const written = unchanged
      ? previous?.written
      : await applyInfraConfigPackage({ cwd, configPackage: pkg, skills })

    const state: InfraState = {
      clientId: config.clientId,
      enabled: true,
      status: 'applied',
      lastSyncAt: now,
      lastSuccessAt: now,
      matchReason: response.matchReason,
      domain: response.domain,
      packageId: pkg.packageId,
      version: pkg.version,
      checksum: pkg.checksum,
      written,
      repo
    }
    await writeInfraState(cwd, state)
    return {
      status: 'applied',
      state,
      message: unchanged ? '企业配置未变化' : `企业配置已应用: ${pkg.packageId}@${pkg.version}`,
      usedCache: false,
      wroteConfig: !unchanged
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stale = previous?.status === 'applied' || previous?.status === 'stale'
    const state: InfraState = {
      ...(previous ?? {
        clientId: config.clientId,
        enabled: true,
        status: 'never_synced' as const
      }),
      enabled: true,
      status: stale ? 'stale' : 'failed',
      lastSyncAt: now,
      lastError: message,
      repo
    }
    await writeInfraState(cwd, state)
    return {
      status: state.status,
      state,
      message: stale ? `企业配置同步失败，继续使用本地缓存: ${message}` : `企业配置同步失败: ${message}`,
      usedCache: stale,
      wroteConfig: false
    }
  }
}

async function downloadSkills(
  config: InfraConfig,
  client: InfraApiClient,
  skills: Array<{ name: string; version: string; downloadUrl?: string }>
): Promise<InfraSkillPackage[]> {
  const packages: InfraSkillPackage[] = []
  for (const skill of skills) {
    if (!skill.downloadUrl) continue
    try {
      packages.push(await client.downloadSkill(skill.downloadUrl))
    } catch {
      // Skill 下载失败不阻断配置包落地；状态里会保留缺失版本
    }
  }
  return packages
}
