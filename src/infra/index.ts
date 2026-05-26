/**
 * 企业 AI 基建（Infra）模块公共导出。
 *
 * 提供配置加载、Git 仓库信息采集、远程配置同步、本地状态持久化、
 * 配置包落地（MCP / AGENTS.md / Skills）以及候选知识上报入口。
 */
export { loadInfraConfig, loadInfraUserInfo } from './config'
export { collectRepoInfo, parseGitRemote } from './git-info'
export { syncInfraConfig } from './sync'
export { submitInfraKnowledgeCandidate, parseKnowledgeCandidateArgs } from './candidate'
export { formatInfraStatus, formatInfraSyncResult, formatInfraState } from './status'
export { readInfraState, writeInfraState, getProjectInfraStatePath } from './state'
export type * from './types'
