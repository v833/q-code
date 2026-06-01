# 工具与 MCP

读者对象：需要新增工具、改工具权限或接 MCP 的人。

## 工具注册表

`ToolRegistry` 统一管理工具：

- 转成 AI SDK tool 格式。
- 执行前后记录审计事件。
- 接 Hook 决策。
- 控制并发和只读属性。
- 给 TUI 发送工具进度。

新增工具时优先走注册表，不要直接让模型调用裸函数。

## 常见工具组

| 位置 | 内容 |
| --- | --- |
| `src/tools/file-tools.ts` | 文件读写编辑 |
| `src/tools/shell-tools.ts` | shell 和后台 job |
| `src/tools/search-tools.ts` | 网络搜索和网页抓取 |
| `src/tools/task-tools.ts` | Task V2 |
| `src/tools/agent-tools.ts` | SubAgent 委派 |
| `src/tools/team-tools.ts` | Agent Teams |

## MCP

`src/mcp` 负责读取 MCP 配置、连接 server、拉取 tools，并注册到 q-code 工具系统。MCP 失败不应阻塞首次启动。

## 安全边界

- 文件读写默认限制在当前工作区。
- shell 默认限制在当前 cwd。
- `.env` 和密钥不能出现在输出中。
- 高风险行为应经过审批或显式配置。
