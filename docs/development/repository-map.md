# 仓库地图

读者对象：准备改代码的人。这里是入口地图，不是完整 API 文档。

## 入口

| 路径 | 负责什么 |
| --- | --- |
| `src/index.ts` | 开发态入口 |
| `src/cli/bootstrap.ts` | 薄启动、early command、动态 import |
| `src/cli/main.ts` | 主交互循环 |

## 核心模块

| 路径 | 负责什么 |
| --- | --- |
| `src/agent` | Agent Loop、重试、循环检测 |
| `src/context` | prompt、压缩、任务、记忆、运行环境 |
| `src/tools` | 内置工具和工具注册表 |
| `src/mcp` | MCP 配置和工具适配 |
| `src/agents` | SubAgent、后台任务、Teams、worktree |
| `src/dashboard` | 本地只读 Web Dashboard 数据采集和 HTTP 服务 |
| `src/terminal` | TUI、输入状态、事件、渲染 |
| `src/session` | 会话存储 |
| `src/observability` | 审计、Langfuse、指标 |
| `src/evals` | Agent eval 平台 |

## 测试目录

| 路径 | 用途 |
| --- | --- |
| `tests/unit` | 低成本模块测试 |
| `tests/integration` | 跨模块流程测试 |
| `tests/_helpers` | mock model、mock tool、临时 home |
| `src/scripts/test-*.ts` | legacy 冒烟脚本 |

## 本地运行数据

这些目录不要提交：

- `.env`
- `.q-code/`
- `.sessions/`
- `dist/`
- `coverage/`
