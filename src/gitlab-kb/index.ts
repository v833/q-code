/**
 * GitLab Wiki 知识库（KB）模块公共导出。
 *
 * 提供配置加载、项目解析、Wiki HTTP 客户端，以及搜索/读取/发布与格式化工具。
 */
export { loadGitLabKbConfig, parseGitLabUrl, type GitLabKbConfig } from './config'
export { GitLabWikiClient, GitLabKbHttpError, slugFromTitle, type GitLabWikiPage } from './client'
export {
  encodeProjectId,
  inferProjectPathFromRepo,
  resolveGitLabKbTarget,
  type GitLabKbTarget
} from './project'
export {
  formatGitLabKbPage,
  formatGitLabKbPages,
  formatGitLabKbPublishResult,
  getGitLabKbStatus,
  parseGitLabKbPublishArgs,
  publishGitLabKbPage,
  readGitLabKbPage,
  searchGitLabKb
} from './operations'
