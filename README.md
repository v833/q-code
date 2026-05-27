# q-code

基于 AI SDK 的命令行 Agent 框架，支持工具调用、可后台运行的 Shell 长任务、Plan Mode、Task V2 持久化任务图、上下文自动压缩、会话持久化、`@file` 文件引用、跨对话项目记忆、Skills 渐进式披露、后台 SubAgent、Worktree 隔离、Agent Teams 多智能体协作和 MCP 扩展。

## 技术栈

| 层面     | 技术                                    |
| -------- | --------------------------------------- |
| 运行时   | Node.js ≥ 22 + TypeScript               |
| AI SDK   | `ai` (Vercel AI SDK) + `@ai-sdk/openai` |
| MCP 协议 | `@modelcontextprotocol/sdk`             |
| 包管理   | pnpm / npm                              |
| 运行方式 | npm CLI 包                              |

## 快速开始

### 环境要求

- Node.js ≥ 22
- npm、pnpm 或其他兼容 npm registry 的包管理器

### 安装

外部用户推荐通过 npm 安装：

```bash
npm install -g @q-code-cli/q-code
q-code
```

全局安装后可直接更新到 npm latest：

```bash
q-code update
q-code update --dry-run  # 仅查看将执行的更新命令
```

首次使用可运行交互式初始化向导，生成 `config.toml`：

```bash
q-code init              # 默认写入 ~/.q-code/config.toml
q-code init --local      # 写入当前项目的 .q-code/config.toml
q-code init --user       # 显式写入用户目录（与默认行为相同）
```

向导会引导填写 OpenAI 兼容 API 的 `base_url`、`api_key`，通过 `/models` 接口校验并选择主模型与摘要模型，可选配置 `[env].file` 复用项目 `.env`；并可选开启 GitLab Wiki 集成（写入 `[gitlab_kb]` 的 `url`、`token`、`prefix`）。

也可以不全局安装，直接临时运行：

```bash
npx @q-code-cli/q-code
```

本地开发时从源码安装依赖：

```bash
pnpm install
```

### 配置

npm 全局安装后推荐使用 `~/.q-code/config.toml`，在任意目录运行 `q-code` 都能读取：

```toml
[openai]
api_key = "sk-..."
base_url = "https://api.openai.com/v1"
model = "gpt-5.4"

[summary]
api_key = "sk-..."
base_url = "https://api.openai.com/v1"
model = "gpt-5.4"

[langfuse]
enabled = false
base_url = "https://cloud.langfuse.com"
record_io = false
```

也可以在项目内使用 `.q-code/config.toml` 覆盖全局配置。配置优先级为：环境变量 > 项目 `.q-code/config.toml` > 全局 `~/.q-code/config.toml` > 项目 `.env` > 内置默认值。

如果你想在 `config.toml` 里复用一份 `.env` 文件，可以这样写：

```toml
[env]
file = ".env.shared"

[openai]
model = "gpt-5.4"
```

`[env].file` 支持相对当前 `config.toml` 的路径，先加载该 `.env`，再由同一个 `config.toml` 里的显式 TOML 键继续覆盖。

本地开发仍可复制环境变量模板并填写：

```bash
cp .env.example .env
```

| 变量                           | 必填 | 说明                                                          |
| ------------------------------ | ---- | ------------------------------------------------------------- |
| `OPENAI_BASE_URL`              | ❌   | OpenAI 兼容 API 地址，默认 `https://api.openai.com/v1`         |
| `OPENAI_API_KEY`               | ✅   | API Key                                                       |
| `OPENAI_MODEL`                 | ❌   | 主模型名称，默认 `gpt-5.4`                                    |
| `SUMMARY_BASE_URL`             | ❌   | 摘要模型 API 地址，默认复用 `OPENAI_BASE_URL`                  |
| `SUMMARY_API_KEY`              | ❌   | 摘要模型 API Key，默认复用 `OPENAI_API_KEY`                    |
| `SUMMARY_MODEL`                | ❌   | 摘要模型名称，默认复用 `OPENAI_MODEL`                          |
| `CONTEXT_LIMIT_TOKENS`         | ❌   | 上下文窗口上限，默认 256000                                   |
| `COMPACT_TRIGGER_RATIO`        | ❌   | 压缩触发比例，默认 0.85                                       |
| `WARNING_TRIGGER_RATIO`        | ❌   | 上下文预警比例，默认 0.80                                     |
| `BLOCKING_TRIGGER_RATIO`       | ❌   | 强制停止比例，默认 0.98，会预留普通输出预算                   |
| `DEFAULT_MAX_OUTPUT_TOKENS`    | ❌   | 普通回答输出上限，默认 8000                                   |
| `ESCALATED_MAX_OUTPUT_TOKENS`  | ❌   | 输出触顶后的升级重试上限，默认 64000                          |
| `COMPACT_MAX_OUTPUT_TOKENS`    | ❌   | 压缩摘要输出上限，默认 20000                                  |
| `Q_CODE_SESSION_DIR`           | ❌   | 会话存储目录，默认 .sessions                                  |
| `Q_CODE_HOME`                  | ❌   | q-code 全局配置目录，默认 `~/.q-code`                         |
| `Q_CODE_DEBUG`                 | ❌   | 设为 1/true/yes/on 显示启动诊断信息（等价于 `--debug`）       |
| `Q_CODE_THEME`                 | ❌   | 代码块高亮主题，`dark` / `light` / `auto`，默认 `auto`        |
| `Q_CODE_AUDIT_ENABLED`         | ❌   | 审计日志开关，默认开启；设为 false/0/off/no 可关闭            |
| `Q_CODE_AUDIT_DIR`             | ❌   | 审计日志目录，默认 `<Q_CODE_HOME>/logs`                       |
| `Q_CODE_AUDIT_RETENTION_DAYS`  | ❌   | 审计日志保留天数，默认 30                                    |
| `Q_CODE_AUDIT_MAX_FILE_BYTES`  | ❌   | 单个审计文件最大字节数，默认 50MB，超出后追加序号轮转        |
| `Q_CODE_AUDIT_MAX_QUEUE_SIZE`  | ❌   | 审计写入内存队列上限，默认 1000                              |
| `Q_CODE_AUDIT_PII`             | ❌   | 默认不写 prompt/tool 原文；设为 `full` 才写入原文             |
| `Q_CODE_CRASH_GUARD`           | ❌   | 崩溃保护开关，默认开启；设为 `false` 可关闭全局兜底 handler  |
| `Q_CODE_LANGFUSE_ENABLED`      | ❌   | Langfuse/OpenTelemetry 导出开关，默认 false                  |
| `LANGFUSE_PUBLIC_KEY`          | ❌   | Langfuse project public key，仅开启 Langfuse 时需要          |
| `LANGFUSE_SECRET_KEY`          | ❌   | Langfuse project secret key，仅开启 Langfuse 时需要          |
| `LANGFUSE_BASE_URL`            | ❌   | Langfuse 实例地址，默认 `https://cloud.langfuse.com`         |
| `Q_CODE_LANGFUSE_RECORD_IO`    | ❌   | 是否上传 prompt/tool/输出原文，默认 false，仅传摘要          |
| `Q_CODE_LANGFUSE_SAMPLE_RATE`  | ❌   | Langfuse turn 采样率，0-1，默认 1                            |
| `Q_CODE_LANGFUSE_ENVIRONMENT`  | ❌   | Langfuse environment 标签，可用于区分 dev/prod/self-hosted   |
| `Q_CODE_LANGFUSE_RELEASE`      | ❌   | Langfuse release 标签，可用于关联版本或提交                  |
| `Q_CODE_LANGFUSE_FLUSH_AT`     | ❌   | Langfuse span 批量 flush 条数，默认 20                       |
| `Q_CODE_LANGFUSE_FLUSH_INTERVAL_SECONDS` | ❌ | Langfuse 定时 flush 间隔秒数，默认 5                         |
| `Q_CODE_LANGFUSE_TIMEOUT_SECONDS` | ❌ | Langfuse 导出请求超时秒数，默认 5                            |
| `Q_CODE_EVAL_JUDGE_BASE_URL`   | ❌   | LLM judge 专用 OpenAI 兼容 base URL；未设时回退 `SUMMARY_BASE_URL` |
| `Q_CODE_EVAL_JUDGE_API_KEY`    | ❌   | LLM judge 专用 API key；未设时回退 `SUMMARY_API_KEY`          |
| `Q_CODE_EVAL_JUDGE_MODEL`      | ❌   | LLM judge 专用模型；未设时回退 `SUMMARY_MODEL`                |
| `Q_CODE_MENTION_ALLOW_ABS`     | ❌   | 设为 true 后允许 `@file` 引用绝对路径；默认只允许当前目录内路径 |
| `Q_CODE_SHELL_TIMEOUT_MS`      | ❌   | `f` 同步命令默认超时，默认 60000ms                           |
| `Q_CODE_SHELL_TIMEOUT_MAX_MS`  | ❌   | `f.timeoutMs` 上限，默认 1800000ms（30 分钟）                 |
| `Q_CODE_SHELL_MAX_BUFFER`      | ❌   | `f` 同步输出内存阈值，默认 4194304（4MB），超出后落盘 spill   |
| `Q_CODE_SHELL_ALLOW_ABS_CWD`   | ❌   | 设为 true 后允许 `f.cwd` 跳出当前工作目录                     |
| `Q_CODE_SHELL_KILL_BG_ON_EXIT` | ❌   | 设为 true 后 q-code 退出时清理仍在运行的 `f` 后台 job         |
| `Q_CODE_SKILL_CHAR_BUDGET`     | ❌   | Skills discovery 注入字符预算，默认 8000                      |
| `Q_CODE_TEAMS`                 | ❌   | 设为 1/true/yes/on 开启 Agent Teams（等价于 `--agent-teams`） |
| `Q_CODE_INFRA_ENABLED`         | ❌   | 是否启用企业 AI 基建集成；默认 false，需显式设为 true         |
| `Q_CODE_INFRA_BASE_URL`        | ❌   | 企业 AI 基建服务地址；仅在 `Q_CODE_INFRA_ENABLED=true` 时使用 |
| `Q_CODE_INFRA_TOKEN`           | ❌   | 企业 AI 基建访问令牌                                          |
| `Q_CODE_INFRA_CLIENT_ID`       | ❌   | Client 实例 ID；不填时自动生成并保存在 `~/.q-code`            |
| `Q_CODE_INFRA_SYNC`            | ❌   | 是否启用启动同步，默认 true；设为 false/0/off 关闭            |
| `Q_CODE_INFRA_TIMEOUT_MS`      | ❌   | 企业配置中心请求超时，默认 5000                               |
| `Q_CODE_INFRA_USER_ID`         | ❌   | 企业用户 ID，用于配置匹配和审计                               |
| `Q_CODE_INFRA_USER_GROUPS`     | ❌   | 企业用户组，逗号分隔                                          |
| `Q_CODE_GITLAB_KB_ENABLED`     | ❌   | 可选开关；设为 false/0/off 可强制关闭 GitLab Wiki 知识库      |
| `Q_CODE_GITLAB_URL`            | ❌   | GitLab 实例或项目地址；配置后启用 GitLab Wiki 知识库          |
| `Q_CODE_GITLAB_TOKEN`          | ❌   | GitLab Personal/Project Access Token，不会在输出中回显        |
| `Q_CODE_GITLAB_PROJECT_ID`     | ❌   | 可选 GitLab project id/path；不填时从 URL 或 git origin 推断  |
| `Q_CODE_GITLAB_KB_PREFIX`      | ❌   | Wiki 知识页前缀，默认 `q-code-kb`                             |
| `Q_CODE_GITLAB_KB_TIMEOUT_MS`  | ❌   | GitLab Wiki API 请求超时，默认 10000                          |
| `MCP_CONNECT_TIMEOUT_MS`       | ❌   | MCP server 连接超时，默认 30000                               |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | ❌   | 旧版 GitHub MCP 兼容入口；新配置建议使用 `mcpServers`         |
| `TAVILY_API_KEY`               | ❌   | Tavily 搜索 API Key                                           |
| `SERPER_API_KEY`               | ❌   | Serper 搜索 API Key                                           |

### 启动

```bash
q-code                  # npm 安装后的新会话
q-code --continue       # 恢复上次会话
pnpm start              # 新建会话
pnpm run continue       # 恢复上次会话
```

### 命令行参数

| 参数                   | 说明                                                     |
| ---------------------- | -------------------------------------------------------- |
| `-h`, `--help`         | 输出帮助信息后退出                                       |
| `-v`, `--version`      | 输出版本号后退出                                         |
| `update`               | 将全局安装的 q-code 更新到 npm latest                    |
| `update --dry-run`     | 只显示更新命令，不实际执行                               |
| `eval list [path...]`  | 列出固定 Agent eval case，默认读取 `evals/smoke`          |
| `eval run [path...]`   | 运行 deterministic Agent eval，输出本地报告和 trace       |
| `eval compare <a> <b>` | 对比两个 eval run 的通过率、分数、进度、token 和成本变化  |
| `eval promote <run> --as <name>` | 保存命名 baseline，供后续 compare 使用           |
| `eval trend`           | 汇总 `.q-code/evals/runs` 历史 run，生成趋势看板          |
| `--continue`           | 恢复上次会话                                             |
| `--session=<id>`       | 指定会话 ID                                              |
| `--dump-system-prompt` | 输出完整 System Prompt 后退出                            |
| `--plan`               | 启动时直接进入 Plan Mode                                 |
| `--agent-teams`        | 启用 Agent Teams 多智能体协作（也可设 `Q_CODE_TEAMS=1`） |
| `--classic`            | 使用传统 readline 交互，不启动 Ink TUI                   |
| `--no-color`           | 关闭 ANSI 语法高亮和颜色输出                               |
| `--debug`              | 显示启动诊断信息，包括 Prompt Pipe 和工具加载概览        |

默认在交互式 TTY 中启动 Ink TUI；非 TTY、`--classic` 或 `Q_CODE_TUI=0` 会回退到传统 readline。TUI 将 Agent 输出、工具调用、上下文占用、任务进度、后台 Agent 和 token 用量统一渲染为事件流，支持 `Shift+Enter`/`Ctrl+J` 多行输入、`Ctrl+R` 历史搜索、`Esc` 清空/恢复输入、忙时 `Ctrl+C` 中断当前任务和 Markdown 代码块/列表/表格展示。多工具任务中，Agent 会在关键工具调用前后输出简短的公开进度说明；TUI 会按时间线把这些说明和工具调用交错展示，避免执行过程中只剩工具流水账。代码块会按语言做 ANSI 语法高亮，可通过 `Q_CODE_THEME=dark|light|auto` 控制配色，或使用 `--no-color` / `NO_COLOR=1` 关闭全部颜色。输入区使用真实终端光标锚定输入法候选窗，避免 macOS IME 跑到屏幕角落。

### @file 文件引用

在 TUI 输入框中输入 `@` 后跟文件名片段，会出现基于仓库文件索引的 fuzzy 候选；使用方向键切换，`Tab` 插入当前候选。例如输入 `@rou` 可以补全到匹配的源码或文档路径。

提交消息时，`@file` 会把文件内容注入本轮用户上下文，并写入 `user.mention` 审计事件。支持以下形式：

```text
请解释 @src/runtime/cli-info.ts
只看一行 @src/runtime/cli-info.ts:42
只看范围 @src/runtime/cli-info.ts:10-30
定位正则 @src/runtime/cli-info.ts:#getEarlyCliCommand
路径含空格 @"My Project/notes.md"
```

默认只允许引用当前工作目录内的文件，并会校验 symlink 指向的真实路径；绝对路径如 `@/etc/passwd` 会被阻止，确需引用绝对路径时设置 `Q_CODE_MENTION_ALLOW_ABS=true`。单个引用最多注入 50KB，单轮全部引用合计最多 200KB，超出时会截断或明确提示丢弃。文件候选优先使用 git 索引，非 git 目录会回退递归扫描；超过 20000 个文件时候选会裁剪并在 TUI 中提示。

### npm 发布

仓库已配置为可发布的 npm CLI 包：

- `bin.q-code` 指向 `dist/index.js`
- `prepack` 会自动执行 `npm run build`
- `prepublishOnly` 会自动执行 typecheck 和全量测试
- 发布包只包含 `dist/`、`README.md`、`LICENSE` 和 `.env.example`

发布前检查：

```bash
pnpm install
pnpm typecheck
pnpm test
npm pack --dry-run
```

确认 npm 登录态和 `q-code-cli` 组织权限后发布：

```bash
npm publish --access public
```

## 架构概览

```
src/
├── index.ts              # 入口：启动、交互循环、压缩调度
├── agent/
│   ├── loop.ts           # Agent Loop 核心（ReAct 模式）
│   ├── loop-detection.ts # 死循环检测
│   └── retry.ts          # 步骤级重试 + 指数退避
├── context/
│   ├── prompt-builder.ts # System Prompt 管道组装
│   ├── compressor.ts     # Microcompact + Summarization
│   ├── offload.ts        # Context Offloading：大工具结果落盘
│   ├── token-budget.ts   # 上下文 token 估算与状态追踪
│   ├── auto-compact.ts   # 压缩熔断器
│   ├── agent-md.ts       # AGENT.md 项目指令加载
│   ├── plan-attachments.ts# Plan Mode 内部提醒
│   ├── plans.ts          # 计划文件读写
│   ├── project-paths.ts  # 项目存储路径计算
│   ├── runtime-context.ts# 运行环境信息采集
│   ├── tasks.ts          # Task V2 持久化任务图
│   ├── todos.ts          # TodoWrite V1 会话级状态
│   └── memory/
│       ├── memdir.ts     # 项目记忆文件读写与索引管理
│       └── memory-types.ts# 记忆类型定义与引导指令
├── session/
│   └── store.ts          # JSONL 会话持久化
├── mentions/             # @file 文件引用解析、索引、fuzzy 补全和上下文注入
├── skills/               # SKILL.md 加载、渐进式披露、条件激活
├── agents/
│   ├── bootstrap.ts      # SubAgent 启动加载
│   ├── registry.ts       # SubAgent 注册表
│   ├── load-agents-dir.ts# 自定义 Agent 文件加载
│   ├── resolve-agent-tools.ts# 子 Agent 工具过滤
│   ├── run-agent.ts      # 同步子 Agent 执行
│   ├── run-async-agent.ts# 后台子 Agent 生命周期
│   ├── async-agent-store.ts# 后台任务状态表
│   ├── notification-store.ts# 后台任务完成通知队列
│   ├── task-output.ts    # 后台任务 JSONL 输出
│   ├── worktree.ts       # Git worktree 隔离
│   └── built-in/         # 内置 SubAgents
├── tools/
│   ├── index.ts          # 工具注册入口
│   ├── registry.ts       # 工具注册表（并发控制、延迟加载）
│   ├── file-tools.ts     # 文件读写编辑
│   ├── shell-tools.ts    # Shell 命令执行
│   ├── search-tools.ts   # 网络搜索 / 网页抓取
│   ├── memory-tools.ts   # 项目记忆写入工具
│   ├── plan-tools.ts     # Plan Mode 工具
│   ├── task-tools.ts     # Task V2 工具
│   ├── todo-tools.ts     # TodoWrite V1 工具
│   ├── utility-tools.ts  # glob / grep / URL 抓取 / 预览
├── terminal/
│   ├── events.ts         # 终端事件总线；TUI、未来 A2A 共享事件协议
│   ├── state.ts          # TUI transcript/status reducer
│   ├── App.tsx           # Ink 交互界面
│   ├── input.ts          # 输入编辑、历史和提交状态机
│   └── markdown.ts       # 轻量 Markdown block 渲染
├── mcp/
│   ├── config.ts         # MCP settings.json 配置加载
│   ├── client.ts         # MCP SDK client + stdio/http/sse transport
│   ├── fetch-tools.ts    # MCP tool → q-code ToolDefinition 适配
│   ├── bootstrap.ts      # 非阻塞启动、重连和注册表刷新
│   ├── registry.ts       # MCP server 连接状态注册表
│   ├── names.ts          # MCP 工具名 normalization
│   └── types.ts          # MCP 配置和连接状态类型
└── utils/
    ├── index.ts
    └── logger.ts         # 格式化输出
```

## 完整工作流程

```
┌─────────────────────────────────────────────────────────────┐
│                        启动阶段                              │
│                                                              │
│  1. 加载环境变量 (.env)                                      │
│  2. 并行启动: MCP 连接 + Skills 加载 + Agents 加载           │
│  3. 加载运行环境信息 + AGENT.md 项目指令                      │
│  4. 初始化会话存储 (新建 / 恢复)                              │
│  5. 注册所有工具 + 设置模式                                   │
│  6. 构建 System Prompt 管道                                  │
│  7. 输出启动信息 (工具数 / Skills / Agents / 任务系统 / 上下文配置) │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    交互循环 (readline)                        │
│                                                              │
│  用户输入 ──→ 斜杠命令? ──→ 是 ──→ 处理内置命令             │
│                  │                                           │
│                  否 → Skill 斜杠展开? → 是 → 展开为消息      │
│                       │                                      │
│                       否 → 构造 user message                 │
│                                                              │
│  ──→ 注入后台 Agent 完成通知 (如有)                          │
│  ──→ 注入 Plan Mode 提醒 (如需)                              │
│  ──→ 保存消息到 SessionStore                                 │
│  ──→ 动态构建 System Prompt (buildSystemPrompt)              │
│  ──→ 进入 Agent Loop                                        │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent Loop (无默认步数硬限制)              │
│                                                              │
│  ┌──→ Step N:                                               │
│  │   1. Preflight: 检查上下文占用，超阈值则压缩              │
│  │   2. 流式调用 LLM (streamText)                            │
│  │   3. 收集工具调用 / 文本输出                              │
│  │   4. 输出触顶? → 升级 maxOutputTokens 重试                │
│  │   5. 执行工具 (并发控制 + 结果截断)                       │
│  │   6. 死循环检测 (三种检测器)                              │
│  │   7. stopAfterToolNames 检查 (如 exit_plan_mode)          │
│  │   8. 无工具调用 → 退出循环                                │
│  └─── 有工具调用 → 继续                                      │
│                                                              │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      后处理阶段                               │
│                                                              │
│  1. 保存新消息到 SessionStore                                │
│  2. Post-turn 压缩检查 (为下一轮腾出空间)                     │
│  3. Plan Mode 审批提示 (如有待确认计划)                      │
│  4. 回到交互循环，等待下一轮输入                              │
└─────────────────────────────────────────────────────────────┘
```

## 核心功能模块

### 1. Agent Loop — 核心推理循环

采用 ReAct（推理-行动交替）模式，主会话不再按默认步数或执行 token 预算硬停：

1. **构建 System Prompt** — 根据用户输入动态构建 `buildSystemPrompt(userQuery)`，使记忆上下文响应当前意图
2. **Preflight** — 检查上下文占用，超阈值则压缩
3. **LLM 推理** — 流式调用模型
4. **工具执行** — 根据模型输出执行对应工具
5. **循环检测** — 识别重复调用并干预
6. **早停检查** — 如 `exit_plan_mode` 等 stopAfterToolNames 命中则停止
7. 无工具调用时退出循环

**步骤级重试**：失败自动重试最多 3 次，带指数退避。

**输出触顶升级**：普通输出 8000 token；因 `length` 触顶且无工具调用时，升级到 64000 token 重试一次。

### 2. JIT Context 与上下文压缩系统

q-code 采用 JIT Context 策略：上下文不在启动时一次性塞满，而是在任务推进到需要证据时再逐步进入模型。目标是减少 Context Rot，降低大仓库、多工具和长会话下的无效 token。

#### Prompt Discipline

System Prompt 会注入固定的 JIT 纪律：

- 不要一开始批量读取可能无关的大文件、网页或长命令输出
- 代码/文件探索优先走 `list_directory/glob → grep → read_file`，先定位路径和行号，再读取精确片段
- 只把能推进当前判断的最小证据放进主上下文
- 宽搜索、噪音探索或可并行调查优先交给 `Agent` / `Explore`，主上下文只接收摘要
- Skills、SubAgents、MCP 工具都按渐进式披露工作：先看名称/摘要/Schema，必要时再加载正文或执行高成本工具

#### 工具成本阶梯

每个工具可以声明 JIT 元数据：

| 字段          | 说明                                                 |
| ------------- | ---------------------------------------------------- |
| `contextCost` | `low` / `medium` / `high`，表示结果进入上下文的成本  |
| `resultShape` | 结果形态，如 `paths`、`lines`、`file`、`web`、`state` |
| `jitHint`     | 给模型的简短使用建议                                 |

`ToolRegistry.getJitToolSummary()` 会按当前 active 工具生成“工具成本阶梯”，并注入 System Prompt。典型分层：

| 成本     | 典型工具                              | 使用方式                         |
| -------- | ------------------------------------- | -------------------------------- |
| 低成本   | `list_directory`、`glob`、`task_list` | 先看轮廓、路径、轻量状态         |
| 中成本   | `grep`、`web_search`、`Skill`、`Agent`| 定位匹配行、拿摘要、隔离宽探索   |
| 高成本   | `read_file`、`web_fetch`、`f`         | 只在目标明确后读取全文或长输出   |

MCP 工具默认 `shouldDefer: true`，只有通过 `tool_search` 激活后才进入 active 工具列表；其元数据也会随 Schema 返回，保持外部工具的渐进式披露。

#### Context Offloading

当上下文占用 ≥ 85%（`COMPACT_TRIGGER_RATIO`）或手动 `/compact` 触发压缩时，q-code 会先执行 Context Offloading，再进入 microcompact 和摘要：

1. **Context Offloading** — 将大工具结果的原文写入磁盘，只在消息里保留 marker、绝对路径、字符数、恢复说明和头尾预览
2. **Microcompact** — 清理旧工具结果，替换为占位符，保留最近 3 个；已 offload 的 marker 会被保留，避免丢失恢复路径
3. **Summarization** — 用独立的摘要模型将旧对话压缩为结构化摘要（用户意图 / 已完成操作 / 关键发现 / 当前状态 / 需保留细节），保留最近 8 条消息

Offload 文件路径：

```text
.sessions/projects/<projectKey>/offloads/<sessionId>/tool-result-0001-<hash>.txt
```

marker 示例：

```text
[tool result offloaded]
tool: read_file
original_chars: 24000
file: /abs/path/.sessions/projects/<projectKey>/offloads/<sessionId>/tool-result-0001-<hash>.txt
restore: 如需完整原始工具结果，使用 read_file 读取上面的 file 路径。
preview:
...
```

Offloading 是无损的：摘要模型只看到短 marker 和预览，后续 Agent 如果确实需要完整结果，可以用 `read_file` 读取 marker 中的文件路径。

**触发时机**：

| 时机      | 说明                             |
| --------- | -------------------------------- |
| Preflight | Agent Loop 每一步调用 LLM 前     |
| Post-turn | 每轮对话结束后，为下一轮腾出空间 |

手动输入 `/compact` 可立即压缩当前会话；压缩熔断器会在连续 3 次自动压缩未能减少上下文时停止尝试，手动压缩不受熔断器拦截。

#### Context / Usage / Cache 可观测性

| 命令                         | 说明                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `/context`                   | 查看当前 system prompt、工具 schema、消息、压缩余量和输出预留矩阵    |
| `/usage`                     | 查看输入/输出 token、cache read/write、实际成本、无 cache 基线和节省 |
| `/cost`                      | `/usage` 的兼容别名                                                  |
| `/cache` / `/cache status`   | 查看当前 cache 模式、cache 命中统计和 system/tools prefix 稳定性     |
| `/cache auto`                | 默认模式：追踪供应商 cache，并只在安全时启用 q-code 显式 cache hints |
| `/cache on`                  | 允许 q-code 对支持的供应商启用显式 cache hints                       |
| `/cache off`                 | 关闭 q-code 显式 cache hints；供应商隐式 cache 仍可能命中并上报      |
| `/status [on|off|toggle]`    | 打开或关闭 TUI 状态详情，默认隐藏 model/cache/context/usage 摘要     |

`/usage` 的成本估算基于内置模型价格表；未知模型仍会统计 token/cache，但成本项会标注不可用。`/cache off` 不能关闭 OpenAI、DeepSeek 等供应商侧的隐式 prompt cache，它只控制 q-code 自身未来可启用的显式 cache hint 策略。

#### 审计日志

q-code 默认开启本地审计日志，按 UTC 日期写入 `<Q_CODE_HOME>/logs/audit-YYYY-MM-DD.ndjson`。每一行是一条 JSON 事件，便于 `tail -f`、归档到 SIEM/ELK，或在故障后按 `sessionId` 和时间窗回放关键行为。

公共字段：

| 字段 | 说明 |
| ---- | ---- |
| `ts` | UTC ISO8601 时间戳 |
| `seq` | 当前进程内自增序号 |
| `pid` | 进程号 |
| `sessionId` | 会话 ID |
| `agent` | `main` / `subagent` / `teammate` 上下文 |
| `event` | 事件名 |
| `payload` | 事件负载 |

首期覆盖事件包括 `session.start` / `session.resume` / `session.end`、`user.prompt`、`agent.step.start` / `agent.step.end`、`tool.call` / `tool.result`、`hook.decision`、`mode.change`、`plan.markReady` / `plan.approve` / `plan.revise`、`subagent.*`、`team.*`、`context.compact` / `context.offload` 和 `error`。

默认 PII 模式不会把用户输入、工具输入、工具输出原文写入日志，只记录 `chars`、`inputChars`、`resultLength` 和 `sha256` 摘要。只有显式设置 `Q_CODE_AUDIT_PII=full` 时，才会把原文写入 `payload.text` / `payload.input` / `payload.output`，建议仅在企业内网或短期调试时使用。

日志文件默认单文件 50MB，超出后写入 `audit-YYYY-MM-DD.1.ndjson`、`audit-YYYY-MM-DD.2.ndjson`。启动时会清理超过 `Q_CODE_AUDIT_RETENTION_DAYS` 的旧文件；写入采用异步串行队列，失败只输出 `[audit]` 警告，不阻塞 Agent 主流程。

CLI 校验与查询：

```bash
q-code audit verify --from 2026-05-25 --to 2026-05-25
q-code audit tail --session <sessionId> --event tool.result --follow
```

#### Langfuse 观测导出

Langfuse 是可选的 OpenTelemetry 导出后端，默认关闭。开启后 q-code 会把每轮 turn、Agent step、AI SDK generation、工具调用和 token usage 作为 Langfuse trace/observation 上报；本地 NDJSON audit 和后续 `.q-code/evals` 仍是源数据，不依赖 Langfuse 才能运行。

推荐在全局或项目 `.q-code/config.toml` 中配置：

```toml
[langfuse]
enabled = true
public_key = "pk-lf-..."
secret_key = "sk-lf-..."
base_url = "https://langfuse.example.com"
record_io = false
sample_rate = 1
```

默认 `record_io=false`，不会上传完整 prompt、文件内容、shell 输出或工具结果，只上报字符数、SHA-256 摘要、工具名、耗时、token 和错误状态。只有显式设置 `Q_CODE_LANGFUSE_RECORD_IO=true` / `record_io = true` 时，才会把输入输出原文交给 Langfuse，建议仅用于自托管实例或短期调试。

#### Agent Eval 与 Langfuse 评测导出

`q-code eval` 是本地优先的 Agent 回归框架，默认用 mock model / mock tool 跑 deterministic case，不需要真实模型 API key，也不会进入普通会话、MCP 或 TUI 初始化。每次 run 会写出：

完整维护指南见 [docs/agent-evals-guide.md](docs/agent-evals-guide.md)。

```text
.q-code/evals/runs/<run-id>/
├── run.json
├── cases.jsonl
├── report.md
└── traces/<case-id>-<repeat>.jsonl
```

常用命令：

```bash
q-code eval list evals/smoke
q-code eval list evals/smoke --tag budget
q-code eval run evals/smoke --no-langfuse
q-code eval run evals/cli --no-langfuse
q-code eval run evals/smoke evals/cli --tag regression --concurrency 2 --report json,md,junit --max-cases 20 --max-duration-ms 60000 --max-cost-usd 0.05
q-code eval run evals/smoke --repeat 3 --langfuse
q-code eval run evals/smoke --langfuse --langfuse-datasets
q-code eval run evals/live --allow-real-model --judge --max-cost-usd 0.05
q-code eval promote .q-code/evals/runs/<run-id> --as main
q-code eval compare main .q-code/evals/runs/candidate
q-code eval trend --limit 30
```

case 文件支持 `mock-agent`、`cli-subprocess` 与 `real-agent` 三种模式。`mock-agent` 用脚本化 mock model/mock tool 验证最终输出、工具轨迹和预算；`cli-subprocess` 会把 `setup.fixture` 复制到隔离 workspace，执行 `cli.command + cli.args`，再评分 stdout/stderr、退出码、文件副作用和 workspace diff；`real-agent` 会复用真实 `agentLoop + ToolRegistry + OPENAI_*` 模型配置，但必须传 `--allow-real-model` 才会执行，默认只暴露只读工具，写文件或 shell 工具必须在 case 的 `real.tools` 中显式列出。断言支持 `final.contains/regex`、`trajectory.strict|unordered|subset`、`requiredTools/forbiddenTools`、`maxExtraTools`、`expectedSteps`、`budgets.maxSteps/maxToolCalls/maxTotalTokens/maxDurationMs/maxCostUsd`、`sideEffects.files[].contains/regex`、`sideEffects.gitDiff`、`safety.forbidSecrets`、`safety.forbiddenOutputPatterns`、`safety.forbiddenToolInputPatterns`、`safety.forbiddenToolOutputPatterns`、`safety.forbiddenPaths`、`checkpoints` 和 opt-in `judge.rubric/threshold/includeTrace`。报告会输出 success、progressRate、progressTimeline、judgeScore、errorType、toolExecutionValidity、toolMetrics、usage、estimatedCostUsd、difficulty breakdown、失败复现命令、trace、stdout/stderr 与 workspace 路径。

`list` 与 `run` 支持 `--grep`、`--tag`、`--exclude-tag`、`--difficulty`、`--mode` 过滤 case；`run` 还支持 `--max-cases`、`--max-duration-ms`、`--max-total-tokens`、`--max-cost-usd` 作为运行级闸门，超过时会生成 `__run_limits__.*` 失败结果并让命令非零退出。成本按 `src/usage/pricing.ts` 的模型价格表估算，mock eval 使用 `q-code-eval-mock` 价格项；缺少价格表的真实模型 case 会保留 token 指标并标记 unknown cost。`--judge` 才会运行 LLM judge，默认用 `Q_CODE_EVAL_JUDGE_*`，未配置时回退 `SUMMARY_*`。`--report` 支持 `json,md,junit`，其中 `run.json` 与 `cases.jsonl` 始终写出；`junit.xml` 用于 CI 展示。`q-code eval promote` 会把一次 run 复制到 `.q-code/evals/baselines/<name>/`，之后可以用 `q-code eval compare <name> <candidate>` 直接对比命名 baseline；`q-code eval trend` 会读取 `.q-code/evals/runs/*/run.json`，写出 `.q-code/evals/trends/trend.json` 与 `trend.md`，用于查看 pass rate、score、progress、tokens、cost 的长期变化。

这套 eval 指标对应一个最小 Agent 质量平台闭环：任务成功率看 `success/passRate`，过程质量看 trajectory 与 progressTimeline，工具可靠性看 toolExecutionValidity/toolMetrics，效率看 steps/tokens/duration/cost，责任安全看 safety/policy scorer，语义质量看 opt-in LLM judge，回归治理看 baseline promote/compare、趋势看板、JUnit CI 和 `.github/workflows/eval-nightly.yml` 定期回归。开启 `Q_CODE_LANGFUSE_ENABLED=true` 时，eval run 会额外导出为 Langfuse `q-code.eval.run` evaluator trace，每个 case 作为 evaluator observation 记录 score、progressRate、errorType、工具指标、token 和估算成本；加 `--langfuse-datasets` 后还会通过 Langfuse Public API 写 dataset item、dataset run item 和 scores。Langfuse 导出失败不会让本地 eval 失败；`.q-code/evals` 仍是评测真源。

#### 崩溃保护

q-code 默认启用崩溃保护。遇到未捕获异常、未处理 Promise rejection 或退出信号时，会尽量恢复终端状态、清理 MCP/后台 Agent 资源、写入审计错误事件，并在 `<Q_CODE_HOME>/crashes` 下生成 `crash-<sessionId>-<timestamp>.json`。

崩溃报告包含 package version、Node/平台信息、sessionId、cwd、当前模型、模式、最后一次用户输入摘要、最后一次工具调用、后台 Agent/MCP 脱敏快照、错误堆栈和内存快照。若崩溃发生在 assistant 流式输出中，会向当前会话追加 `[crashed mid-stream]` 标记，方便 `q-code --continue` 恢复时识别上一轮未完成。

可通过 `Q_CODE_CRASH_GUARD=false` 关闭该兜底 handler。关闭后未捕获异常会回到 Node 默认行为，不再生成 crash 报告。

**预算状态分三级**：

| 状态       | 阈值                              | 行为               |
| ---------- | --------------------------------- | ------------------ |
| `warning`  | ≥ 80%（`WARNING_TRIGGER_RATIO`）  | 提醒上下文吃紧     |
| `error`    | ≥ 85%（`COMPACT_TRIGGER_RATIO`）  | 触发自动压缩       |
| `blocking` | ≥ 98%（`BLOCKING_TRIGGER_RATIO`） | 停止下一次模型请求 |

`blocking` 阈值会同时参考 `BLOCKING_TRIGGER_RATIO` 和普通输出预算，避免输入已经贴近窗口上限时还发起请求。

**模型输出分三档**：普通回答默认 8000 token；如果模型因为 `length` 触顶且本步没有工具调用，会用 64000 token 重试一次；压缩摘要默认 20000 token，避免长会话摘要被截断。

### 3. 死循环检测

三种检测器并行工作：

| 检测器                   | 触发条件                    | 警告  | 强制停止 |
| ------------------------ | --------------------------- | ----- | -------- |
| `generic_repeat`         | 同一工具 + 相同参数重复调用 | ≥5 次 | ≥8 次    |
| `ping_pong`              | 两个工具交替循环            | ≥5 次 | ≥8 次    |
| `global_circuit_breaker` | 同一工具无进展重复          | —     | ≥10 次   |

`warning` 级别注入系统提醒，`critical` 级别直接终止循环。

### 4. 工具系统

#### 内置工具

| 类别     | 工具                                                        | 功能                                                    |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| 文件操作 | `read_file` / `write_file` / `edit_file` / `list_directory` | 读写编辑文件、列出目录                                  |
| Shell    | `f` / `f_status` / `f_tail` / `f_kill` / `f_list`           | Shell 命令执行、后台长任务和输出增量读取                    |
| 搜索     | `glob` / `grep` / `pick_search`                             | 文件搜索 / 内容搜索 / 代码库语义搜索                    |
| 网络     | `fetch_url` / `web_fetch`                                   | 网页抓取                                                |
| 实用     | `start_preview`                                             | 本地预览服务                                            |
| 记忆     | `memory_write`                                              | 跨对话项目记忆写入                                      |
| 技能     | `Skill`                                                     | 按需加载并执行 SKILL.md 工作流                          |
| 子代理   | `Agent`                                                     | 同步或后台启动独立上下文的 SubAgent，支持 worktree 隔离 |
| 计划     | `enter_plan_mode` / `plan_write` / `exit_plan_mode`         | Plan Mode 切换、计划写入与提交                          |
| 任务 V2  | `task_create` / `task_update` / `task_get` / `task_list`    | Task V2 持久化任务图                                    |
| 待办 V1  | `todo_write`                                                | TodoWrite V1 会话级任务清单，全量替换，全部完成自动清空 |
| 动态发现 | `tool_search`                                               | 延迟工具动态发现                                        |

#### Shell 工具

`f` 默认执行同步命令，Windows 使用 PowerShell7，其他平台使用 Bash。参数支持 `cwd`、`timeoutMs`、`maxBufferBytes`、`stdin`、`env`、`label` 和 `background`：

- 同步模式默认超时 60s，受 `Q_CODE_SHELL_TIMEOUT_MS` 控制；用户传入的 `timeoutMs` 会被 `Q_CODE_SHELL_TIMEOUT_MAX_MS` 限制。
- 输出超过 `maxBufferBytes`（默认 4MB）不会杀进程，会把完整输出写入 `<Q_CODE_HOME>/shell-spills/<jobId>.log`，工具结果返回 head/tail 摘要和文件路径。
- 执行过程中 stdout/stderr 会以节流进度写入 TUI 的 JIT 状态；`--classic` 下会直接打印进度行。
- `cwd` 默认只能位于当前工作目录内；确需跳出时设置 `Q_CODE_SHELL_ALLOW_ABS_CWD=true`。
- 交互提示（如 `password:`、`(y/n)`、`Enter ...`）会在短暂宽限后终止并返回 `interactive_not_supported`；针对根目录的 `rm -rf /`（含 `-fr`、拆分 `-r`/`-f`、`--recursive`/`--force` 长选项、`sudo rm -rf /` 等常见写法）、fork bomb、`mkfs`、危险 `dd` 会直接拦截。

后台模式使用 `f({ command, background: true })`，立即返回 `jobId`、`pid`、`outputFile` 和 `startedAt`。后续可用：

| 工具       | 说明                                                      |
| ---------- | --------------------------------------------------------- |
| `f_status` | 查看 job 的 `running/completed/failed/killed`、退出码和耗时 |
| `f_tail`   | 按 `fromOffset` / `maxBytes` 增量读取输出文件             |
| `f_kill`   | 终止后台 job 的进程树                                     |
| `f_list`   | 列出当前进程内已知 shell job                              |

后台 job 元数据会追加到 `<Q_CODE_HOME>/shell-jobs/<sessionId>.index`。默认退出 q-code 不主动杀后台 job；可设置 `Q_CODE_SHELL_KILL_BG_ON_EXIT=true`，或在 `settings.json` 中配置：

```json
{
  "shell": {
    "killBackgroundOnExit": true
  }
}
```

#### 自定义工具目录

q-code 支持从两个目录扫描“目录式”自定义工具，并按固定优先级覆盖同名工具：

1. `<cwd>/.q-code/tools/<tool-name>/`
2. `~/.q-code/tools/<tool-name>/`
3. 内置工具

每个工具目录至少包含一个 `schema.json`，格式为：

```json
{
  "name": "demo_tool",
  "description": "示例自定义工具",
  "parameters": {
    "type": "object",
    "properties": {
      "value": { "type": "string" }
    },
    "required": ["value"],
    "additionalProperties": false
  },
  "isReadOnly": true,
  "isConcurrencySafe": true,
  "execute": "node ./index.js"
}
```

约定说明：

- `schema.json` 结构为 `Omit<ToolDefinition, 'isEnabled' | 'execute'> & { execute: string }`
- 工具目录名必须与 `schema.json.name` 完全一致
- 子目录缺少 `schema.json` 时会在启动时输出 `[tools] Skipping …` 警告并跳过
- `execute` 是可在 shell 中直接执行的命令，执行目录固定为当前工具目录
- 工具目录中可以放置任意配套文件，例如 `index.js`、模板、脚本或静态资源
- 运行时会把工具输入通过 `stdin` 传给命令，默认 payload 为：

```json
{
  "version": 1,
  "input": { "value": "hello" },
  "context": {
    "cwd": "/abs/project",
    "sessionId": "optional-session-id"
  }
}
```

- 命令 `stdout` 如果是合法 JSON，会按结构化工具结果解析；否则按普通文本结果返回
- 命令非零退出、超时、输出过大或启动失败时，会转成结构化工具错误并进入现有审计/Hooks 管线

#### 并发控制

- `isConcurrencySafe` 工具可并发执行
- 非 safe 工具独占执行，互斥等待
- 工具可声明 `contextCost` / `resultShape` / `jitHint`，System Prompt 会自动生成当前工具成本阶梯
- 工具结果超过各自 `maxResultChars` 时自动截断（保留头 60% + 尾部）
- 工具执行上下文带 `cwd`，子 Agent 使用 worktree 隔离时，文件、Shell、grep/glob、记忆写入等工具都会相对 worktree 执行

### 5. Plan Mode — 规划模式

Plan Mode 是"只看不动"的规划模式，适合复杂、多文件、需要先确认方案的任务。q-code 不引入权限系统，而是在每次模型请求前动态过滤工具列表：Plan Mode 下只暴露只读工具、`plan_write` 和 `exit_plan_mode`，隐藏 `write_file`、`edit_file`、`f`、`memory_write` 等会修改项目或环境的工具。

计划文件存储在 `.sessions/projects/<projectKey>/plans/<sessionId>.md`。模型完成探索后会写入计划并调用 `exit_plan_mode`，当前 loop 会停住等待用户确认，避免"退出计划后立刻实现一遍、审批后又实现一遍"的问题。

| 命令                  | 说明                           |
| --------------------- | ------------------------------ |
| `/mode`               | 查看当前模式和计划文件路径     |
| `/mode plan`          | 手动进入 Plan Mode             |
| `/mode normal`        | 手动回到 normal 模式           |
| `/plan`               | 查看当前计划文件内容           |
| `/approve-plan`       | 批准计划并切回 normal 模式执行 |
| `/revise-plan <反馈>` | 不批准当前计划，带反馈继续规划 |

### 6. 任务系统（双模式）

#### Task V2 持久化任务图（默认模式）

用文件级持久化任务图跟踪复杂工作。适合多步骤、跨回合、带依赖关系的任务；Plan Mode 下也允许使用，因为它只修改任务状态，不改项目文件或外部环境。

存储结构：

```text
.sessions/projects/<projectKey>/tasks/<sessionId>/
├── 1.json
├── 2.json
└── .highwatermark
```

每个任务一个 JSON 文件，`.highwatermark` 记录最大已分配 id。即使删除任务或 `/tasks reset` 清空当前任务图，后续新任务也不会复用旧 id。

任务字段：

| 字段          | 说明                                             |
| ------------- | ------------------------------------------------ |
| `id`          | 稳定递增的字符串 id                              |
| `subject`     | 祈使句单行标题，例如"运行测试"                   |
| `description` | 任务细节和验收标准                               |
| `activeForm`  | 进行中文案，可选                                 |
| `status`      | `pending` / `in_progress` / `completed`          |
| `blocks`      | 当前任务阻塞的下游任务 id                        |
| `blockedBy`   | 阻塞当前任务的上游任务 id                        |
| `metadata`    | 可选元信息，`task_update` 里传 `null` 可删除 key |

工具约定：

- `task_create` 创建任务，返回 `Task #<id> created: <subject>`
- `task_list` 列出当前任务图；`pending` 且所有上游依赖已完成的任务会标为 `ready`
- `task_get` 读取完整任务详情；`task_update` 前应先读取最新状态
- `task_update` 支持改字段、改状态、添加 `addBlocks` / `addBlockedBy`，并双向维护依赖
- `task_update` 的 `status=deleted` 会删除任务，同时清理其他任务中的依赖引用

#### TodoWrite V1 会话清单（兼容模式）

会话级临时便签，给模型一张"便签纸"跟踪短小临时任务。不是默认模式，需要时通过 `/tasks todo` 切换。

`todo_write` 的输入是完整 todo 列表，每次调用都会全量替换旧列表。TodoItem 只有三个字段：

| 字段         | 说明                                    |
| ------------ | --------------------------------------- |
| `content`    | 祈使句任务描述，例如"运行测试"          |
| `status`     | `pending` / `in_progress` / `completed` |
| `activeForm` | 当前进行时文案，例如"正在运行测试"      |

设计约束：

- 没有 `id` 字段，避免模型在多轮对话中记错合成标识符
- 通常保持恰好一个任务为 `in_progress`
- 当所有任务都标记为 `completed` 时，清单会自动清空
- Task V2 与 TodoWrite V1 互斥：Task 模式只暴露 `task_*` 工具，Todo 模式只暴露 `todo_write`
- Plan Mode 下也允许 `todo_write`，因为它只写会话状态，不修改文件或环境

| 命令           | 说明                                             |
| -------------- | ------------------------------------------------ |
| `/tasks`       | 查看当前任务系统和任务列表                       |
| `/tasks task`  | 切回 Task V2 持久化任务图                        |
| `/tasks todo`  | 切到 TodoWrite V1 兼容模式                       |
| `/tasks reset` | 清空当前 session 的任务图，保留 `.highwatermark` |
| `/todos`       | 查看当前会话任务清单                             |
| `/todos clear` | 清空当前会话任务清单                             |

### 7. Skills 渐进式披露

Skills 用 Markdown 描述可复用工作流，适合代码审查、提交辅助、排障流程等"多步套路"。q-code 启动时只把每个可见 Skill 的 `name + description` 注入 `<system-reminder>`，不会把完整 `SKILL.md` 正文塞进 system prompt；模型调用 `Skill` 工具或用户输入 `/<skill-name> args` 时，才按需读取正文并继续本轮推理。

目录：

```text
~/.q-code/skills/<name>/SKILL.md      # 用户级，跨项目共享
~/.agents/skills/<name>/SKILL.md      # 用户级，跨项目共享；同名覆盖 ~/.q-code/skills
<cwd>/.q-code/skills/<name>/SKILL.md  # 项目级，仅当前仓库；同名覆盖用户级
<cwd>/.agents/skills/<name>/SKILL.md  # 项目级，仅当前仓库；同名优先级最高
```

支持的 frontmatter：

| 字段                       | 说明                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `name`                     | Skill 名称，默认目录名                                                                |
| `description`              | discovery 列表中的一行简介；缺失时取正文第一段                                        |
| `when_to_use`              | 何时使用该 Skill 的提示，会追加到简介                                                 |
| `allowed-tools`            | 兼容字段，当前 q-code 无权限系统，仅解析保留                                          |
| `argument-hint`            | `/skills` 展示的参数提示                                                              |
| `disable-model-invocation` | 为 `true` 时不出现在模型可见列表，只能用户用 `/<name>` 触发                           |
| `paths`                    | gitignore 风格路径；命中 `read_file` / `write_file` / `edit_file` / `glob` 后条件激活 |

正文变量会在调用时替换：`$ARGUMENTS`、`${Q_CODE_SKILL_DIR}`、`${Q_CODE_SESSION_ID}`；同时兼容 Claude Code 风格的 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`。

| 命令                 | 说明                          |
| -------------------- | ----------------------------- |
| `/skills`            | 查看已加载 Skills、来源和状态 |
| `/<skill-name> args` | 用户直接触发 Skill            |

### 8. SubAgents 子任务分发

SubAgent 用于把搜索重、上下文噪音大的聚焦任务交给独立子 Agent。子 Agent 从一条全新的 user message 开始，使用经过过滤的工具集运行同一套 Agent Loop，最后只把简洁摘要通过 `Agent` 工具返回给主 Agent。

内置角色：

| Agent             | 说明                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `general-purpose` | 默认通用子 Agent，适合需要多次工具调用的聚焦子任务                   |
| `Explore`         | 只读探索 Agent，只保留只读工具，适合定位文件、追踪调用和梳理实现模式 |

自定义 Agent 文件：

```text
~/.q-code/agents/<name>.md      # 用户级，跨项目共享
<cwd>/.q-code/agents/<name>.md  # 项目级，仅当前仓库；同名覆盖用户级
```

格式：

```markdown
---
name: reviewer
description: Use for focused code review of a small change set.
tools: 'read_file,grep,glob'
disallowedTools: 'write_file,edit_file'
model: 'gpt-5.4'
maxTurns: 12
isolation: worktree
---

You are a focused code review sub-agent. Return findings first, then residual risk.
```

字段说明：

| 字段              | 说明                                         |
| ----------------- | -------------------------------------------- |
| `name`            | `Agent` 工具中的 `subagent_type`             |
| `description`     | discovery 列表里的使用时机说明               |
| `tools`           | 可选 allow-list；缺省或 `*` 表示继承父工具池 |
| `disallowedTools` | 可选 deny-list；即使 `tools: "*"` 也会剔除   |
| `readOnlyOnly`    | 为 `true` 时只保留 `isReadOnly` 工具         |
| `model`           | 可选模型覆盖；缺省继承父 Agent 默认模型      |
| `maxTurns`        | 子 Agent 最大循环步数，缺省 30               |
| `isolation`       | 默认隔离级别：`none` 或 `worktree`           |

`Agent` 工具参数：

| 参数                | 说明                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `prompt`            | 必填，自包含任务说明；子 Agent 看不到主对话历史                    |
| `description`       | 必填，短任务名，用于日志和结果摘要                                 |
| `subagent_type`     | 可选，目标 Agent 类型，缺省 `general-purpose`                      |
| `model`             | 可选，本次调用模型覆盖                                             |
| `run_in_background` | 可选，为 `true` 时后台运行并立即返回 `<async_launched>`            |
| `isolation`         | 可选，本次调用隔离覆盖：`none` / `worktree`；优先级高于 Agent 定义 |

结构性约束：

- 子 Agent 永远拿不到 `Agent` 工具，避免递归分发
- 子 Agent 永远拿不到 `enter_plan_mode` / `plan_write` / `exit_plan_mode`，避免子任务反向修改父会话模式
- `Explore` 使用 `readOnlyOnly`，会剔除写文件、shell、任务写入等非只读工具
- 子 Agent 不继承主对话历史；传给 `Agent.prompt` 的内容必须自包含
- 新增或修改自定义 Agent 文件后需要重启 q-code

#### 后台 Agent 与 Worktree

`run_in_background: true` 会让 `Agent` 工具立即返回 `<async_launched>`，其中包含 `agent_id` 和 `.output` 文件路径。后台子 Agent 使用独立 `AbortController` 继续运行，不会阻塞主对话。运行过程中会把进度写入 JSONL：

```text
.sessions/projects/<projectKey>/async-agents/<sessionId>/<agentId>.output
```

常见事件包括 `started`、`text`、`tool_use`、`tool_result`、`turn_usage`、`completed`、`failed`。后台任务完成、失败或被终止后，会进入 pending notification 队列；下一轮用户输入开始前，q-code 会把 `<task-notification>` 注入对话，让主 Agent 继续基于结果工作。

`isolation: "worktree"` 会为本次子任务创建独立 Git worktree：

```text
<gitRoot>/.q-code/worktrees/<agentId>/
```

子 Agent 的文件读写、Shell、grep/glob 和记忆写入都会相对该 worktree 执行。任务结束时，q-code 会检查 worktree 是否有未提交改动或新 commit：干净则自动移除；有改动或检查失败则保留，并在结果或通知里返回 `worktree_path` 和 `worktree_branch`，方便人工 review 或合并。若当前目录不在 Git 仓库内，worktree 创建失败会降级为无隔离并返回 warning。

| 命令                | 说明                                                |
| ------------------- | --------------------------------------------------- |
| `/agents`           | 查看已加载 SubAgents、后台任务、输出文件和 worktree |
| `/agents kill <id>` | 请求终止运行中的后台 Agent                          |

### 9. Agent Teams 多智能体协作

Agent Teams 在 SubAgent 的基础上增加了**网状通信**：teammate 之间可以直接 SendMessage 互相对齐，不必把每条消息都中转给 lead；适合需要长期并行、跨角色协作的复杂任务（如 backend + frontend + reviewer 同时推进一个特性）。

**启用**：用 `--agent-teams` 启动 q-code 或设置 `Q_CODE_TEAMS=1`。关闭状态下三个团队工具完全不向模型暴露。

**核心模型**：

```text
~/.q-code/teams/<team>/
├── team.json              ← TeamFile（成员注册表 + lead 信息）
└── inboxes/
    ├── backend.json       ← backend 的收件箱
    ├── frontend.json      ← frontend 的收件箱
    └── team-lead.json     ← lead 的收件箱
```

每个进程同一时间只能领导一个团队（`teamContext` 单例约束）；teammate 不能再嵌套 TeamCreate 或派出二级 teammate。

**三个工具**：

| 工具          | 作用                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `TeamCreate`  | 开启团队会话，把当前进程注册为 lead                                                                |
| `SendMessage` | 把纯文本消息丢进收件人的收件箱（`to: "*"` 广播；自发自收会被拒绝）                                 |
| `TeamDelete`  | 解散团队，删 team.json + 所有 inbox + 干净 worktree（脏 worktree 保留）；要求所有 teammate 已 idle |

**Agent 工具的扩展**：原有 `Agent({ ... })` 增加可选参数 `name` + `team_name`：

```js
Agent({
  subagent_type: 'general-purpose',
  name: 'backend',
  team_name: 'refactor-auth',
  run_in_background: true,
  prompt: '实现 /api/auth 的 JWT 认证',
  description: '后端认证模块'
})
```

文档要求的 7 条校验全部覆盖：

| 校验                            | 错误信息                                   |
| ------------------------------- | ------------------------------------------ |
| `name` 但 Agent Teams 未启用    | `Agent Teams feature is not enabled`       |
| 只传 `name` 或只传 `team_name`  | `name and team_name must be used together` |
| 没有活跃团队                    | `no team is active`                        |
| `team_name` 与活跃团队不一致    | `team_name does not match active team`     |
| `name` 等于保留字 `team-lead`   | `team-lead is reserved`                    |
| 调用者本身已是 teammate（嵌套） | `nested teammate spawn rejected`           |
| `run_in_background` 不为 true   | `named teammates must run in background`   |

**通信流**：teammate 启动时 `runChildAgent` 会先 `drainUnreadMessages` 把所有未读邮件以 `<teammate-messages>` 上下文块拼到第一条 user prompt 前面；teammate 终止（成功/失败/被 kill）时 `runAsyncAgent` 在 `finally` 块里把 `isActive` 翻成 `false`，`<task-notification>` 在下一轮用户输入前注入对话。

**System prompt 三档**：

| 状态         | 注入内容                               |
| ------------ | -------------------------------------- |
| 特性开关关闭 | 空字符串                               |
| 开启但无团队 | 提示模型 TeamCreate 的使用时机         |
| 已有活跃团队 | 完整 roster（active/idle）+ 工作流规则 |

| 命令                 | 说明                                         |
| -------------------- | -------------------------------------------- |
| `/teams`             | 查看活跃团队、成员状态、磁盘上的所有团队目录 |
| `/teams clear`       | 清理当前团队（要求无活跃 teammate）          |
| `/teams clear force` | 强制清理（建议先 `/agents kill <agent_id>`） |

### 10. MCP 扩展

q-code 支持标准 `mcpServers` 配置，把外部 MCP server 适配成普通工具。配置分两级：

| 路径                          | 说明                                           |
| ----------------------------- | ---------------------------------------------- |
| `~/.q-code/settings.json`     | 全局 MCP 配置；可通过 `Q_CODE_HOME` 改变根目录 |
| `<cwd>/.q-code/settings.json` | 项目级 MCP 配置；同名 server 整条覆盖全局配置  |

示例：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

支持的 transport：

| 类型    | 说明                                                             |
| ------- | ---------------------------------------------------------------- |
| `stdio` | 默认类型；本地子进程，如 `npx -y @modelcontextprotocol/server-*` |
| `http`  | Streamable HTTP；适合远端 SaaS / 自建服务                        |
| `sse`   | 旧版 SSE；headers 会同时注入 POST 和长连 GET                     |

MCP 工具名会规范化为 `mcp__<server>__<tool>`，例如 `my.db` 的 `echo.tool` 会变成 `mcp__my_db__echo_tool`。MCP 工具默认延迟加载，Agent 需要时通过 `tool_search` 按需激活，避免大量外部工具撑大 System Prompt。

启动时 MCP 连接在后台并行进行：慢 server 不会阻塞 CLI；连接成功后工具会增量注册。`--dump-system-prompt` 会等待 MCP bootstrap 完成，方便检查最终 prompt。

兼容说明：如果未配置 `mcpServers.github`，但设置了 `GITHUB_PERSONAL_ACCESS_TOKEN`，q-code 会按旧行为自动添加一个 GitHub stdio MCP server。新项目建议迁移到 `settings.json`。

| 命令                          | 说明                                      |
| ----------------------------- | ----------------------------------------- |
| `/mcp`                        | 查看 MCP server 状态、transport、工具数量 |
| `/mcp tools <serverName>`     | 查看某个 server 暴露的工具                |
| `/mcp reconnect <serverName>` | 清理缓存并重连某个 server                 |

### 10.1 企业 AI 基建配置同步

企业 AI 基建是可选集成功能，默认关闭。只有显式配置 `Q_CODE_INFRA_ENABLED=true` 后，q-code 才会读取 `Q_CODE_INFRA_BASE_URL` 和 `Q_CODE_INFRA_TOKEN`，并在启动时向企业配置中心解析当前仓库所属业务域，再把配置包增量写入本地项目：

```text
<cwd>/.q-code/settings.json      # 企业 MCP server 配置
<cwd>/.q-code/skills/<name>/     # 云端下发 Skills
<cwd>/.q-code/infra-state.json   # 最近一次同步状态
<cwd>/AGENTS.md                  # 企业规则受管区块
```

未开启 `Q_CODE_INFRA_ENABLED` 时，q-code 不会写入任何企业配置文件，原有本地行为保持不变。开启后若配置中心不可用，Client 会保留最近一次成功状态，并在 `/infra status` 中标记为 `stale` 或 `failed`。

| 命令            | 说明                                      |
| --------------- | ----------------------------------------- |
| `/infra`        | 查看企业配置同步状态，等价于 `/infra status` |
| `/infra status` | 查看业务域、配置包版本、本地写入路径和错误 |
| `/infra sync`   | 手动重新拉取配置；若配置变化会刷新 MCP 连接 |

### 10.2 GitLab Wiki 仓库知识库

GitLab Wiki 知识库是一个可选外部集成。配置 GitLab URL 和 Token 后，q-code 会把当前仓库对应的 GitLab Project Wiki 当作企业内部知识共享载体：团队成员只要拥有该项目 Wiki 的访问权限，就能共享仓库级 FAQ、排障结论、工程约定和架构决策。

推荐在全局或项目 `.q-code/config.toml` 中配置：

```toml
[gitlab_kb]
url = "https://gitlab.example.com/group/project"
token = "glpat-..."
prefix = "q-code-kb"
```

`url` 可以是 GitLab 实例地址，也可以是项目地址；如果没有显式配置 `project_id`，q-code 会优先从项目地址推断，再尝试从当前仓库 `remote.origin.url` 推断。默认只读写 `q-code-kb/` 前缀下的 Wiki 页面，避免和人工维护的 Wiki 首页混在一起。

| 命令 | 说明 |
| --- | --- |
| `/gitlab-kb` 或 `/kb` | 查看配置和项目解析状态 |
| `/gitlab-kb list [关键词]` | 列出或搜索知识页 |
| `/gitlab-kb get <slug>` | 读取单个 Wiki 知识页 |
| `/gitlab-kb publish --title "标题" [--slug slug] <正文>` | 发布或更新知识页 |

配置后模型也会按需获得 `gitlab_kb_search`、`gitlab_kb_read`、`gitlab_kb_publish` 三个延迟工具；未配置时这些工具不会暴露给模型。

### 11. 会话持久化与项目记忆

#### 会话持久化

采用 JSONL append-only 格式存储在 `.sessions/projects/<projectKey>/<sessionId>.jsonl`，支持：

- `--continue` 恢复最近一次会话
- `--session=<id>` 指定会话 ID
- 崩溃恢复：逐行解析，损坏行跳过
- 压缩快照全量写入，恢复时从最后快照后加载

每个会话会同步维护 `.sessions/projects/<projectKey>/<sessionId>.meta.json`，记录展示名、创建/更新时间、消息数、tokens、首条用户输入摘要、模型和 tags。老会话没有 meta 时，`/sessions` 首次列表会从 JSONL 自动回填。

TUI 内可直接使用 `/sessions` 管理会话，不需要重启进程：

| 命令 | 说明 |
| ---- | ---- |
| `/sessions` 或 `/sessions list [--all]` | 列出最近会话；TUI 中可用 ↑/↓ 选择并 Enter 切换 |
| `/sessions info [<id>]` | 查看当前或指定会话详情 |
| `/sessions switch <id>` | 不重启进程切换到指定会话 |
| `/sessions new ["<displayName>"]` | 新建会话并立即切换 |
| `/sessions rename <id> "<name>"` | 修改展示名 |
| `/sessions delete <id> [--force]` | 默认软删到 `.trash`；`--force` 物理删除 |
| `/sessions restore <id>` | 从 `.trash` 恢复 |
| `/sessions export <id> [--format md|json|html] [--out <path>]` | 导出会话，默认写入 `exports/` |
| `/sessions search <keyword> [--all]` | 跨会话搜索 user/assistant 文本 |
| `/sessions purge [--older-than 30d]` | 预览并确认清理过期 trash 会话 |

#### 项目记忆系统

q-code 内置跨对话持久化的项目记忆，让 Agent 能在多次对话间保留和检索关键信息。

存储结构：

```text
.sessions/projects/<projectKey>/memory/
├── MEMORY.md           # 索引文件（自动维护）
├── deploy-rules.md     # 主题记忆文件
└── api-conventions.md  # 主题记忆文件
```

每个记忆文件使用 YAML frontmatter 格式：

```markdown
---
name: 部署规则
description: 生产环境部署注意事项
type: project
---

正文内容...
```

索引文件 `MEMORY.md` 是自动维护的索引，不保存完整正文，只包含指向各主题文件的链接：

```markdown
# Project Memory

- [部署规则](deploy-rules.md) — 生产环境部署注意事项
- [API 约定](api-conventions.md) — REST API 命名与版本规范
```

索引上限：200 行 / 25000 bytes，超出自动截断。

记忆类型：

| 类型        | 说明                                         |
| ----------- | -------------------------------------------- |
| `user`      | 用户长期偏好、协作方式、目标或角色信息       |
| `feedback`  | 用户对执行方式、质量标准、注意事项的长期反馈 |
| `project`   | 不能直接从仓库推导的项目约束、背景、决策     |
| `reference` | 外部系统、仪表盘、文档、工单或数据源位置     |

**写入记忆**：Agent 通过 `memory_write` 工具写入记忆，支持新建和更新已有文件（按 name/description 匹配）。

**读取记忆**：Agent 启动时，记忆索引自动注入 System Prompt。当用户提到历史约定或相关主题时，Agent 会主动 `read_file` 读取对应记忆文件。

**记忆边界**：

- 会话历史保存一次对话过程；项目记忆只沉淀跨对话仍然成立的信息
- 不保存能从仓库直接读取的内容（代码结构、文件内容等）
- 不保存 git 已能表达的信息（提交历史、diff 等）
- 不保存一次性调试过程或临时计划
- 使用记忆前应先验证当前状态，记忆与实际冲突时以验证为准

**忽略记忆**：用户输入包含 "忽略记忆" / "ignore memory" 等关键词时，本轮对话不应用任何已保存记忆。

## 测试体系

q-code 把测试拆成两层：**Vitest 单元/集成测试**（生产可用、覆盖率友好）+ **Legacy 端到端脚本**（单文件 `tsx` 直跑、面向真实模块联调）。

### 目录结构

```text
tests/
├── _helpers/                 # 共享测试基础设施
│   ├── mock-model.ts         # 基于 MockLanguageModelV3 的脚本化模型
│   ├── mock-tool.ts          # makeMockTool / makeRecordingTool / makeFlakeyTool
│   └── temp-home.ts          # 隔离 Q_CODE_HOME 的 fixture
├── unit/                     # 纯函数 + 模块级单元测试
│   ├── atomic-write.test.ts
│   ├── retry.test.ts
│   ├── loop-detection.test.ts
│   ├── tool-registry.test.ts
│   └── prompt-builder.test.ts
└── integration/              # 跨模块集成 + 真实文件系统
    ├── agent-loop.test.ts    # mock model 驱动 ReAct 循环
    ├── session-recovery.test.ts
    ├── session-switch.test.ts
    ├── task-graph.test.ts
    └── team-flow.test.ts

src/evals/                    # q-code eval 本地评测框架
├── loader.ts                  # 读取 evals/**/*.yaml|json
├── runner.ts                  # mock-agent / cli-subprocess / real-agent runner + artifact 输出
├── trace-recorder.ts          # agentLoop 回调转 JSONL trace
├── judge.ts                   # opt-in LLM-as-judge scorer
├── scorers.ts                 # final/trajectory/budget/safety/tool/side-effect scorer
├── langfuse-api.ts            # Langfuse dataset run items / scores Public API bridge
├── langfuse-export.ts         # 可选 Langfuse evaluator trace 导出
└── trend.ts                   # 本地趋势看板 JSON/Markdown
```

### 命令

| 命令                    | 用途                                          |
| ----------------------- | --------------------------------------------- |
| `pnpm test`             | 跑所有 vitest 单元 + 集成测试（默认 CI 入口） |
| `pnpm test:watch`       | watch 模式开发                                |
| `pnpm test:coverage`    | 生成 v8 覆盖率报告（HTML + lcov）             |
| `pnpm test:unit`        | 仅跑 `tests/unit`                             |
| `pnpm test:integration` | 仅跑 `tests/integration`                      |
| `pnpm test:legacy`      | 跑 `src/scripts/test-*.ts` 全套端到端脚本     |
| `pnpm test:all`         | vitest + legacy 全部                          |
| `pnpm typecheck`        | `tsc --noEmit` 全项目类型检查                 |
| `pnpm eval:smoke`       | 运行 deterministic smoke eval，不导出 Langfuse |
| `pnpm eval:cli`         | 运行 cli-subprocess fixture eval，不导出 Langfuse |
| `pnpm eval:ci`          | 运行 smoke + cli eval，并输出 JUnit 报告        |
| `pnpm eval:smoke:langfuse` | 运行 smoke eval 并导出到配置的 Langfuse       |
| `pnpm eval:nightly`     | 运行定期 deterministic 回归并生成趋势看板       |
| `pnpm eval:trend`       | 从历史 eval runs 生成本地趋势看板               |
| `pnpm eval:compare`     | 对比两个 eval run                              |

### 关键覆盖点

| 主题             | 测试位置                                                                       |
| ---------------- | ------------------------------------------------------------------------------ |
| 文件原子性       | `unit/atomic-write.test.ts` — 100 次顺序 + 50 次并发零 tmp 残留                |
| 重试退避         | `unit/retry.test.ts` — 指数退避边界 + 错误分类                                 |
| 死循环防护       | `unit/loop-detection.test.ts` — 三种检测器三档阈值                             |
| 并发锁           | `unit/tool-registry.test.ts` — 独占/共享锁、cwd/abort/identity 透传            |
| Prompt 管道      | `unit/prompt-builder.test.ts` — pipe 顺序、空跳过、各内置 pipe 字段透传        |
| Agent ReAct 循环 | `integration/agent-loop.test.ts` — mock 模型 + mock 工具的多步 ReAct + abort   |
| 会话恢复/切换    | `integration/session-recovery.test.ts` / `integration/session-switch.test.ts` — 损坏 JSONL 行恢复、压缩快照分界、无重启切换 |
| 任务图           | `integration/task-graph.test.ts` — CRUD + 双向依赖 + reset 不复用 id           |
| Agent Teams      | `integration/team-flow.test.ts` — 完整流程 + reconcile + 并发邮箱 + 大小限制   |
| Agent Eval       | `unit/evals.test.ts` — 加载 smoke/cli/live case、运行 runner、生成 trace、报告、judge 解析、趋势看板和副作用 artifact |

### Mock 基础设施

写新集成测试时，引入 `tests/_helpers/`：

```typescript
import { agentLoop } from '../../src/agent/loop'
import { ToolRegistry } from '../../src/tools/registry'
import { createMockModel } from '../_helpers/mock-model'
import { makeRecordingTool } from '../_helpers/mock-tool'

const { tool, calls } = makeRecordingTool('probe', '工具结果')
const registry = new ToolRegistry({ cwd: '/tmp', quiet: true })
registry.register(tool)

const { model } = createMockModel([
  { tools: [{ name: 'probe', input: { foo: 1 } }] },
  { text: '完成', finishReason: 'stop' }
])

await agentLoop(model, registry, [{ role: 'user', content: 'go' }], 'sys', {
  quiet: true
})
```

`createMockModel(turns)` 接收一个脚本数组，每一项描述一次 `streamText` 调用应该输出什么；如果脚本耗尽，会自动产生一个空 stop 轮让循环优雅退出。

### 持续集成与 pre-commit

| 触发                        | 命令                       | 耗时      | 内容                                    |
| --------------------------- | -------------------------- | --------- | --------------------------------------- |
| 本地 `git commit`           | `pnpm precommit`           | ~6 秒     | typecheck + 单元测试（`tests/unit/**`） |
| GitHub Actions（push / PR） | `.github/workflows/ci.yml` | ~1-2 分钟 | typecheck + vitest 全部 + legacy 端到端 |

#### 本地 pre-commit hook

仓库使用 [`simple-git-hooks`](https://github.com/toplenboren/simple-git-hooks)（零运行时依赖、配置写在 `package.json`）。`pnpm install` 时会通过 `prepare` 脚本自动把 hook 安装到 `.git/hooks/pre-commit`，每次 commit 前会自动跑：

```bash
pnpm typecheck && pnpm test:unit
```

跳过 hook（仅紧急时使用）：

```bash
SKIP_SIMPLE_GIT_HOOKS=1 git commit -m "..."
```

或者：

```bash
git commit -n -m "..."   # 等同于 --no-verify
```

为什么 pre-commit 只跑单元测试：

- 集成测试要起 git worktree 和真实 fs，几秒到 30 秒不等，pre-commit 太重
- 单元测试 + typecheck 已能挡掉 90% 的明显 bug，留下的让 CI 兜底
- 节省的等待时间 = 更频繁的小提交 = 更好的 git 历史

#### GitHub Actions

`.github/workflows/ci.yml` 在 `push main` 与 `pull_request to main` 时触发，按以下顺序跑：

1. `pnpm typecheck`
2. `pnpm test`（vitest 单元 + 集成）
3. `pnpm test:legacy`（5 套端到端脚本）

并发策略：同一分支推新 commit 自动取消上一轮 CI（`concurrency` + `cancel-in-progress`）。

## 辅助系统

### 项目指令

在项目目录或 `~/.q-code/` 下放置 `AGENT.md` 或 `AGENTS.md`，内容会作为项目级指令注入 System Prompt。加载顺序：

1. `~/.q-code/AGENT.md` — 全局指令
2. 项目根目录到当前目录的链式加载
3. 冲突时，路径越接近当前目录的优先级越高

### System Prompt 管道

System Prompt 由 `PromptBuilder` 按管道顺序拼接，每个 Pipe 可根据上下文动态开关：

| Pipe                              | 说明                               |
| --------------------------------- | ---------------------------------- |
| `coreRules`                       | 核心行为准则                       |
| `modeContext`                     | 当前模式上下文                     |
| `toolGuide`                       | 工具使用引导                       |
| `taskGuide` / `taskContext`       | Task V2 使用引导与当前任务图       |
| `todoGuide` / `todoContext`       | TodoWrite V1 使用引导与当前清单    |
| `skillsContext` / `agentsContext` | Skills 与 SubAgents discovery 提醒 |
| `deferredTools`                   | 延迟加载工具摘要                   |
| `runtimeEnvironment`              | 运行环境信息（OS、Git 分支等）     |
| `agentMdInstructions`             | AGENT.md 项目指令                  |
| `projectMemory`                   | 项目记忆上下文与索引               |
| `sessionContext`                  | 会话信息                           |

每轮用户输入时，`buildSystemPrompt(userQuery)` 会根据用户查询动态重建 System Prompt，使记忆上下文可以响应当前意图（如用户要求忽略记忆时，对应内容会被清空）。

## 数据存储结构

```text
.sessions/projects/<projectKey>/
├── <sessionId>.jsonl          # 会话持久化 (JSONL)
├── async-agents/
│   └── <sessionId>/
│       └── <agentId>.output   # 后台 Agent JSONL 进度输出
├── plans/
│   └── <sessionId>.md         # 计划文件
├── tasks/
│   └── <sessionId>/
│       ├── 1.json             # 任务文件
│       ├── 2.json
│       └── .highwatermark     # ID 高水位
└── memory/
    ├── MEMORY.md              # 记忆索引
    └── <topic>.md             # 主题记忆文件

~/.q-code/ (或 Q_CODE_HOME)
├── settings.json              # 全局 MCP 配置
├── AGENT.md                   # 全局项目指令
├── skills/<name>/SKILL.md     # 用户级 Skills
├── agents/<name>.md           # 用户级自定义 Agents
├── shell-spills/<jobId>.log   # f 同步超大输出 spill
└── shell-jobs/<sessionId>.index# f 后台 job 元数据索引

~/.agents/skills/<name>/SKILL.md      # 用户级 Skills（覆盖 ~/.q-code/skills 同名 Skill）

<cwd>/.q-code/
├── settings.json              # 项目级 MCP 配置
├── AGENT.md                   # 项目级指令
├── skills/<name>/SKILL.md     # 项目级 Skills
├── agents/<name>.md           # 项目级自定义 Agents
└── evals/runs/<run-id>/       # 本地 Agent eval artifact（run/cases/report/traces）

<gitRoot>/.q-code/worktrees/
└── <agentId>/                 # 后台 Agent worktree 隔离目录
```

## CLI 命令总览

交互式启动默认进入 TUI。快捷键：`Enter` 发送，`Shift+Enter`/`Ctrl+J` 换行，`↑/↓` 切换历史，`Ctrl+R` 搜索历史，`Esc` 清空/恢复输入，忙时 `Ctrl+C` 中断当前任务，空闲时 `Ctrl+C` 退出。需要旧版纯文本交互时使用 `pnpm start -- --classic` 或设置 `Q_CODE_TUI=0`。

TUI 状态栏默认只展示当前状态；需要查看模式、模型、cache 策略、任务系统、context 进度和 token 摘要时使用 `/status on` 打开详情，`/status off` 关闭。已完成历史会静态输出，流式输出期间只刷新当前轮，并限制 streaming 预览高度以减少 VSCode 等终端闪烁。执行中会同时保留中间进度旁白和工具调用摘要；等最终回答出现后，已完成工具调用会折叠，只留下对话内容。输入 `/` 时命令建议按类别分组展示，工具调用默认以一行紧凑摘要呈现，失败时显示恢复建议。

| 命令                    | 说明                   |
| ----------------------- | ---------------------- |
| `/context`              | 查看上下文占用矩阵     |
| `/sessions`             | 列出/切换/管理会话     |
| `/history`              | `/sessions list` 的兼容视图 |
| `/usage`                | 查看 token/cache/成本  |
| `/cost`                 | `/usage` 的兼容别名    |
| `/cache [status|auto|on|off]` | 查看或切换 cache 策略 |
| `/status [on|off|toggle]` | 打开或关闭 TUI 状态详情 |
| `/compact [focus]`      | 手动触发上下文压缩     |
| `/mode`                 | 查看当前模式           |
| `/mode plan`            | 进入 Plan Mode         |
| `/mode normal`          | 回到 Normal 模式       |
| `/plan`                 | 查看当前计划文件       |
| `/approve-plan`         | 批准计划并切回 normal  |
| `/revise-plan <反馈>`   | 不批准，带反馈继续规划 |
| `/tasks`                | 查看当前任务系统       |
| `/tasks task`           | 切到 Task V2           |
| `/tasks todo`           | 切到 TodoWrite V1      |
| `/tasks reset`          | 清空任务图             |
| `/todos`                | 查看会话任务清单       |
| `/todos clear`          | 清空清单               |
| `/skills`               | 查看已加载 Skills      |
| `/<skill-name> args`    | 触发 Skill             |
| `/agents`               | 查看已加载 SubAgents   |
| `/agents kill <id>`     | 终止后台 Agent         |
| `/infra`                | 查看企业 AI 基建配置同步状态 |
| `/infra sync`           | 手动同步企业配置       |
| `/gitlab-kb` 或 `/kb`   | 查看 GitLab Wiki 知识库状态 |
| `/gitlab-kb list`       | 列出/搜索 Wiki 知识页  |
| `/gitlab-kb get <slug>` | 读取 Wiki 知识页       |
| `/mcp`                  | 查看 MCP 状态          |
| `/mcp tools <name>`     | 查看某 server 的工具   |
| `/mcp reconnect <name>` | 重连某 server          |
| `exit`                  | 退出                   |

## 开发验证

```bash
pnpm run test:agents   # SubAgents + 后台 Agent + worktree 隔离
pnpm run test:skills   # Skills 渐进式披露
pnpm run test:mcp      # MCP smoke test
pnpm run eval:smoke    # deterministic Agent eval
pnpm run eval:cli      # CLI subprocess side-effect eval
pnpm run eval:trend    # 生成 eval 趋势看板
pnpm exec tsc --noEmit # TypeScript 类型检查
```

### 源码文档约定

- `src/` 下生产模块在文件头提供**模块级中文说明**；对外导出函数、类、接口、类型与常量配有 **JSDoc**（行为、边界、副作用以当前实现为准）。
- 复杂非显然逻辑辅以少量行内注释（说明「为何」而非复述代码）；TUI 组件仅文档化导出符号与关键 props。
- 目录职责与协作约定见仓库根目录 `AGENTS.md`；API 细节以源码 JSDoc 为准，README 不重复维护完整符号表。

## License

MIT
