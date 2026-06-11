# 目录速查

| 路径 | 说明 |
| --- | --- |
| `src/cli` | CLI 启动和主循环 |
| `src/agent` | Agent Loop |
| `src/context` | Prompt、压缩、任务、记忆 |
| `src/tools` | 工具定义和注册 |
| `src/file-history` | Agent 写工具文件历史快照与 `/rewind` 回滚 |
| `src/mcp` | MCP server 接入 |
| `src/agents` | SubAgent、后台 Agent、Teams |
| `src/output-styles` | Output Styles 加载、持久化和动态 prompt 格式化 |
| `src/user-commands` | Markdown User Commands 加载和模板展开 |
| `src/dashboard` | 本地只读 Web Dashboard |
| `src/terminal` | Ink TUI |
| `src/session` | 会话存储 |
| `src/observability` | 审计和外部 trace |
| `src/evals` | Agent eval |
| `tests/unit` | 单元测试 |
| `tests/integration` | 集成测试 |
| `docs` | VitePress 文档站 |

## 扩展目录

| 路径 | 说明 |
| --- | --- |
| `~/.q-code/output-styles/*.md` | 用户级回答风格 |
| `<project>/.q-code/output-styles/*.md` | 项目级回答风格 |
| `~/.q-code/commands/**/*.md` | 用户级 Slash prompt 模板 |
| `<project>/.q-code/commands/**/*.md` | 项目级 Slash prompt 模板 |
| `<Q_CODE_HOME>/file-history/<projectKey>/<sessionId>/` | `/rewind` 文件正文备份 |
| `~/.q-code/settings.json` | 用户级 settings，如 `outputStyle`、Hooks、MCP |
| `<project>/.q-code/settings.json` | 项目级 settings |

不要提交本地运行产物：`.env`、`.q-code/`、`.sessions/`、`dist/`、覆盖率输出。
