# q-code 项目协作说明

## 项目概览

`q-code` 是一个基于 Vercel AI SDK 的 TypeScript 命令行 Agent 框架。核心能力包括：

- **Agent / 任务**：Agent Loop、Plan Mode、Task V2、TodoWrite、上下文压缩、会话持久化（JSONL append-only）、`@file` 文件引用注入、项目记忆、Skills、SubAgent、Agent Teams、Worktree 隔离。
- **工具执行**：文件/搜索工具、可配置超时与 spill 的 Shell 工具、后台 Shell job（`f_status` / `f_tail` / `f_kill` / `f_list`）。
- **集成扩展**：MCP server、Hooks（pre/post tool-use 决策）、Slash 命令注册表、企业 AI 基建同步（Infra）、GitLab Wiki 知识库。
- **可观测性**：NDJSON 审计日志（默认开启）、崩溃保护（crash guard，默认开启）与 crash report、Usage / Cache / 成本统计、Token Budget。
- **TUI**：基于 Ink 的交互式 TUI（默认）、`--classic` 经典 readline、可经管道/CI 自动降级。
- **CLI 子命令**：`q-code help|version|update|audit`（启动前 short-circuit），其余参数走主交互循环。

## 环境与工具

- 运行时：Node.js 22+。
- 包管理器：pnpm。不要混用 npm/yarn 生成新的 lockfile。
- 源码直接通过 `tsx` 运行，项目为 ESM：`package.json` 中 `"type": "module"`。
- TypeScript 严格模式开启，模块解析为 `bundler`，目标为 `ES2022`。
- 本仓库存在 `.env`，其中可能包含本地敏感配置；不要在回复、日志或提交中暴露密钥明文。

## 常用命令

```powershell
pnpm install
pnpm start                  # tsx src/index.ts
pnpm continue               # tsx src/index.ts --continue

pnpm typecheck              # tsc --noEmit
pnpm test                   # vitest run（unit + integration）
pnpm test:unit              # vitest run tests/unit
pnpm test:integration       # vitest run tests/integration
pnpm test:watch             # vitest watch
pnpm test:coverage          # vitest run --coverage

pnpm test:legacy            # 串行：test-mcp + test-skills + test-agents + test-async-agents + test-teams
pnpm test:mcp
pnpm test:skills
pnpm test:agents            # test-agents + test-async-agents
pnpm test:teams
pnpm test:infra-candidate

pnpm test:all               # pnpm test && pnpm test:legacy
pnpm precommit              # typecheck + test:unit
pnpm build                  # 调 scripts/build.mjs，产出 dist/
```

- 提交前优先运行 `pnpm precommit`，它会执行 `pnpm typecheck && pnpm test:unit`。
- 影响 Agent Loop、工具注册、会话、任务图、MCP、Skills、Hooks、Slash、审计日志或 SubAgent 行为时，优先补跑相关集成测试或 legacy 脚本。
- CI 使用 Node.js 22 和 pnpm 9，并按 `typecheck -> pnpm test -> pnpm test:legacy` 顺序执行。

## CLI 子命令

以下子命令由 `src/runtime/cli-info.ts::getEarlyCliCommand` 在进入主循环前路由，不会触发会话/MCP 初始化：

- `q-code help` / `--help` / `-h`：打印帮助。
- `q-code version` / `--version` / `-v`：打印版本号。
- `q-code update [--dry-run]`：把全局 `@q-code-cli/q-code` 升级到 npm latest。
- `q-code audit verify [--from YYYY-MM-DD] [--to YYYY-MM-DD]`：校验本地 NDJSON 审计日志。
- `q-code audit tail [--session <id>] [--event <name>] [--follow]`：按会话/事件过滤查看审计日志。

主交互循环还接受以下启动参数：`--continue`、`--session <id>`、`--plan`、`--agent-teams`、`--classic`、`--debug`、`--dump-system-prompt`。

## 目录边界

- `src/index.ts`：CLI 启动、交互循环、模式切换、上下文压缩调度和整体编排。
- `src/agent/`：核心 Agent Loop、重试、循环检测。
- `src/agents/`：SubAgent、后台 Agent、Agent Teams、worktree、mailbox、notification-store。
- `src/context/`：System Prompt 管道、上下文压缩与 offload、任务、Todo、记忆、运行环境和项目指令加载。
- `src/tools/`：内置工具定义、注册表（含审计/Hooks 包装层）、自定义工具目录加载器、文件/搜索/计划/任务/团队/Memory/Skill/GitLab KB/Agent 等工具；`shell-tools.ts` 负责 `f`、后台 shell job、输出 spill、cwd 策略和危险命令/交互保护。
- `src/mcp/`：MCP 配置、连接、工具适配和注册表。
- `src/skills/`：Skills 加载、预算、条件激活和斜杠命令展开。
- `src/slash/`：斜杠命令注册表、解析、suggestions、formatHelp（`/help` 输出由此驱动）。
- `src/hooks/`：Pre/Post tool-use Hooks 的配置加载、matcher、command-runner 与 DefaultHookRunner。
- `src/observability/`：NDJSON 审计日志（`audit.ts`）与 `q-code audit verify|tail` 子命令实现（`audit-cli.ts`）。
- `src/runtime/`：早期 CLI 子命令路由（help/version/update/audit）、`getPackageVersion`、`runCliUpdate`、`installCrashGuard` 与崩溃报告生成。
- `src/config/`：`runtime-config.ts` 负责加载 `~/.q-code/config.toml`、`<cwd>/.q-code/config.toml`、`.env`，统一映射到 `process.env`（支持多 section/alias）。
- `src/session/`：`SessionStore`（JSONL append-only、原子写入、cache 模式与 usage 记录持久化）。
- `src/mentions/`：`@file` 文件引用解析、git/递归文件索引、fuzzy 排序、路径安全校验、文件内容截断和本轮上下文注入。
- `src/usage/`：token 归一化、定价、cache 策略、`UsageTracker` 与 `/usage` 渲染。
- `src/infra/`：企业 AI 基建配置同步（base URL / token / sync 状态 / 知识候选上报）。
- `src/gitlab-kb/`：GitLab Wiki 知识库读取/搜索/发布（`/gitlab-kb` 命令背后逻辑）。
- `src/terminal/`：Ink TUI、输入状态机、事件流、Markdown 渲染、表格、主题（`theme/`）、布局/光标 utils。
- `src/utils/`：通用工具（logger、原子写、字符串、环境变量布尔判定等）。
- `tests/unit/`：低成本单元测试。
- `tests/integration/`：跨模块行为验证（agent-loop、session-recovery、task-graph、audit-trail、team-flow 等）。
- `tests/_helpers/`：测试通用 helpers（mock-model、mock-tool、temp-home）。
- `src/scripts/test-*.ts`：legacy 端到端/冒烟脚本（MCP、Skills、Agents、AsyncAgents、Teams、Infra Candidate）。

## 实现约定

- 优先延续现有函数式模块风格和具名导出方式。
- 代码注释保持克制，只解释复杂流程或非显然约束。
- 修改用户可见行为时，同步更新 README 中对应命令、架构、环境变量或工作流说明。
- **新增/移除模块、目录、CLI 子命令、Slash 命令、Hook 事件、环境变量、测试脚本或协作约定时，必须同步改写本 `AGENTS.md`**，按以下对应关系补充：
  - 新模块/新顶层目录 → `## 目录边界`
  - 新 npm script / 新 legacy 脚本 → `## 常用命令`
  - 新 `q-code <subcommand>` 或新启动参数 → `## CLI 子命令`
  - 新核心能力（如 Plan Mode 同级特性） → `## 项目概览`
  - 新代码/写文件/审计/安全约定 → `## 实现约定`
  - 新测试套件或专项跑法 → `## 测试策略`
  - PR 中没改 `AGENTS.md` 的新功能，视为未完成；评审优先回退或要求补全。
- 文件和会话持久化逻辑优先使用项目已有的原子写入、路径计算和存储 helper（如 `SessionStore`、`Q_CODE_HOME` 解析、`auditDir` 解析），避免临时拼接路径。
- Prompt、工具描述、项目说明多为中文；新增用户可见文案时优先保持中文一致性。
- 新增环境变量需同时更新：(a) `.env.example`；(b) `src/config/runtime-config.ts` 的 `SECTION_ALIASES`（让 toml 配置可用）；(c) README 配置表。
- 工具默认通过 `ToolRegistry.toAISDKFormat` 包装，会自动写 `tool.call` / `tool.result` 审计事件；新增工具入口或绕过 registry 时需自行接审计与 Hooks 管线（参考 `src/observability/audit.ts::getAuditLogger`）。
- `@file` mention 默认只能引用当前工作目录内文件，并必须校验 symlink 解析后的真实路径；绝对路径必须显式设置 `Q_CODE_MENTION_ALLOW_ABS=true`，并写 `user.mention` 审计事件。单文件/总附件预算变更需同步 README 和 `src/mentions/file-mentions.ts` 常量。
- Shell 工具默认只能在当前 `cwd` 内执行；跳出目录必须显式设置 `Q_CODE_SHELL_ALLOW_ABS_CWD=true`。长命令优先使用 `timeoutMs` 或 `background=true`，超大输出通过 `<Q_CODE_HOME>/shell-spills` 恢复全文，后台 job 元数据写 `<Q_CODE_HOME>/shell-jobs`。
- 自定义工具目录固定为 `~/.q-code/tools/<name>/` 与 `<cwd>/.q-code/tools/<name>/`；项目级覆盖用户级，用户级覆盖内置工具。每个工具目录必须提供 `schema.json`，其结构为 `Omit<ToolDefinition, 'isEnabled' | 'execute'> & { execute: string }`，其中 `execute` 会在该工具目录下作为 shell 命令运行。
- 新增 Slash 命令通过 `createSlashCommandRegistry` + `command(...)` 注册（见 `src/index.ts::createBuiltinSlashCommands`），并填好 `category`、`aliases`、`usage`，以便 `/help` 输出友好。
- 新增 Hook 事件类型时同步更新 `src/hooks/events.ts` 与 `src/hooks/types.ts` 的导出，并在 `tests/unit/hooks.test.ts` 加覆盖。
- 新增企业相关能力（Infra / GitLab KB / 审计 PII 模式）必须保持可禁用：环境变量缺省值不能让首次启动失败。
- 崩溃保护默认开启，新增崩溃处理逻辑必须避免依赖 Ink 输出；用户提示走裸 `stderr.write`，报告默认写 `<Q_CODE_HOME>/crashes`，测试里使用 `register: false` 和 mock `exit`。
- TypeScript 严格模式 + `moduleResolution: bundler` + `target: ES2022`；优先使用 `import type`、避免 `any`，公共边界用具名 interface。
- 不要将 `.sessions/`、`.q-code/`（含 `.q-code/logs/`、`.q-code/crashes/`、`.q-code/agents/`、`.q-code/skills/`）、`node_modules/`、`dist/`、覆盖率输出或本地 `.env` 纳入提交。

## 测试策略

- 小型纯逻辑改动：至少运行 `pnpm test:unit`，必要时指定相关测试文件，例如：
  - 审计日志改动：`vitest run tests/unit/audit-logger.test.ts tests/integration/audit-trail.test.ts`
  - Hooks 改动：`vitest run tests/unit/hooks.test.ts`
  - Slash 改动：`vitest run tests/unit/slash.test.ts`
  - Tool registry 改动：`vitest run tests/unit/tool-registry.test.ts`
  - Shell 工具改动：`vitest run tests/unit/shell-tools.test.ts tests/integration/shell-streaming.test.ts`
  - 自定义工具目录改动：`vitest run tests/unit/custom-tools.test.ts tests/unit/tool-registry.test.ts`
  - `@file` 文件引用：`vitest run tests/unit/file-mentions.test.ts tests/unit/terminal.test.ts tests/unit/runtime-config.test.ts`
  - 终端/输入状态机改动：`vitest run tests/unit/terminal.test.ts`
  - 运行时配置/CLI 子命令：`vitest run tests/unit/runtime-config.test.ts tests/unit/cli-info.test.ts tests/unit/update.test.ts`
  - 崩溃保护：`vitest run tests/unit/crash-guard.test.ts tests/unit/mcp-bootstrap.test.ts tests/unit/audit-logger.test.ts`
  - Infra / GitLab KB：`vitest run tests/unit/infra.test.ts tests/unit/infra-candidate.test.ts tests/unit/gitlab-kb.test.ts`
- 类型、接口或公共工具改动：运行 `pnpm typecheck`。
- 涉及 Agent Loop、上下文、会话恢复、任务图、团队协作或审计端到端：运行 `pnpm test` 或相关 `tests/integration/**`（含 `agent-loop`、`session-recovery`、`task-graph`、`team-flow`、`audit-trail`）。
- 涉及 MCP、Skills、Agents、Teams 或 worktree 端到端行为：运行对应 `pnpm test:mcp`、`pnpm test:skills`、`pnpm test:agents`、`pnpm test:teams`、`pnpm test:infra-candidate`，必要时运行 `pnpm test:legacy`。

## Git 与提交注意

- 当前主分支是 `main`。
- 工作区可能存在用户改动；修改前先查看状态，避免覆盖不相关变更。
- pre-commit hook 由 `simple-git-hooks` 安装，默认执行 `pnpm precommit`。
- 只有在用户明确要求时才跳过 hook 或执行提交。
- 发现值得提issue的想法时，可以直接提到github issue中
