# q-code 项目协作说明

## 项目概览

`q-code` 是一个基于 Vercel AI SDK 的 TypeScript 命令行 Agent 框架。核心能力包括：

- **Agent / 任务**：Agent Loop、Plan Mode（自然语言审批、智能进入与 Shift+Tab 切换）、Task V2、TodoWrite、上下文压缩、会话持久化与 TUI `/sessions` 管理、TUI `/agents` SubAgent Monitor（同步与后台 SubAgent，completed 默认隐藏并可清理，忙碌等待期间可用 `Ctrl+A` 查看）、只读同步 SubAgent 动态并行调度、TUI 输入历史跨进程持久化、`@file` 文件引用注入与候选索引缓存/监听刷新、项目记忆、Skills、SubAgent、Agent Teams、Worktree 隔离。
- **工具执行**：文件/搜索工具、可配置超时与 spill 的 Shell 工具（Windows 优先 PowerShell7，缺失时回退 Windows PowerShell 5.1）、后台 Shell job（`f_status` / `f_tail` / `f_kill` / `f_list`）。
- **集成扩展**：MCP server、Hooks（pre/post tool-use 决策）、Slash 命令注册表、企业 AI 基建同步（Infra）、GitLab Wiki 知识库。
- **可观测性**：NDJSON 审计日志（默认开启）、模型等待心跳、`ttftMs`/`elapsedMs`/TPS step 诊断、可选 Langfuse/OpenTelemetry trace 导出、崩溃保护（crash guard，默认开启）与 crash report、Usage / Cache / 成本统计、上下文占用预警、启动时版本更新说明（对比 `~/.q-code/last-version.json` 与包内 `changelog.json`）。
- **评测**：`q-code eval` 本地优先 Agent 质量平台，覆盖固定任务集、mock/cli/真实模型 runner、LLM judge（opt-in）、工具轨迹、预算/成本、进度、文件副作用、策略安全、JSONL trace、Markdown/JUnit 报告、baseline 对比、趋势看板、定期回归与可选 Langfuse evaluator trace / dataset / scores 导出。
- **TUI**：基于 Ink 的交互式 TUI（默认）、`--classic` 经典 readline、可经管道/CI 自动降级；主 Agent 默认人格为「小黄鸭」，可用 `/ya` 主动切换到主题鸭「降压鸭」「屁老鸭」。
- **CLI 子命令**：`q-code help|version|update|audit|init`（启动前 short-circuit），其余参数走主交互循环。

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

pnpm eval:smoke             # 运行 deterministic smoke eval，不导出 Langfuse
pnpm eval:cli               # 运行 cli-subprocess fixture eval，不导出 Langfuse
pnpm eval:ci                # 运行 smoke + cli eval，并输出 JUnit 报告
pnpm eval:smoke:langfuse    # 运行 smoke eval 并按配置导出到 Langfuse
pnpm eval:nightly           # 运行定期 deterministic 回归并生成趋势看板
pnpm eval:trend             # 从历史 eval runs 生成本地趋势看板
pnpm eval:compare           # 对比两个 eval run

pnpm test:all               # pnpm test && pnpm test:legacy
pnpm precommit              # typecheck + test:unit
pnpm build                  # 调 scripts/build.mjs：自动生成 changelog 并产出 dist/
pnpm changelog              # 手动从 git tag / conventional commit 生成 CHANGELOG（调试用）
```

- 提交前优先运行 `pnpm precommit`，它会执行 `pnpm typecheck && pnpm test:unit`。
- 影响 Agent Loop、工具注册、会话、任务图、MCP、Skills、Hooks、Slash、审计日志或 SubAgent 行为时，优先补跑相关集成测试或 legacy 脚本。
- CI 使用 Node.js 22 和 pnpm 9，并按 `typecheck -> pnpm test -> pnpm test:legacy` 顺序执行；`.github/workflows/eval-nightly.yml` 定期执行 `pnpm eval:nightly` 做 deterministic 质量回归；`.github/workflows/changelog.yml` 仅在推送 version tag（`v*`）时自动同步 `CHANGELOG.md` / `changelog.json`（PR 无需手动维护）；`pnpm build` 会在打包前自动生成 `changelog.json` 并复制到 `dist/`。

## CLI 子命令

以下子命令由 `src/runtime/cli-info.ts::getEarlyCliCommand` 在进入主循环前路由，不会触发会话/MCP 初始化：

- `q-code help` / `--help` / `-h`：打印帮助。
- `q-code version` / `--version` / `-v`：打印版本号。
- `q-code update [--dry-run]`：把全局 `@q-code-cli/q-code` 升级到 npm latest。
- `q-code audit verify [--from YYYY-MM-DD] [--to YYYY-MM-DD]`：校验本地 NDJSON 审计日志。
- `q-code audit tail [--session <id>] [--event <name>] [--follow]`：按会话/事件过滤查看审计日志。
- `q-code init [--user|-u] [--local|-l]`：交互式初始化 `config.toml`（默认用户目录；`--local` 写入项目 `.q-code/config.toml`）。
- `q-code eval list [path...]`：列出固定 eval case，默认读取 `evals/smoke`。
- `q-code eval run [path...] [--tag <tag>] [--mode <mode>] [--max-cases N] [--max-total-tokens N] [--max-cost-usd N] [--repeat N] [--concurrency N] [--report json,md,junit] [--out <dir>] [--langfuse|--no-langfuse] [--langfuse-datasets] [--allow-real-model] [--judge]`：运行 Agent eval，输出 `.q-code/evals/runs/<run-id>/` artifact；真实模型和 judge 必须显式 opt-in。
- `q-code eval compare <baseline-name|baseline-run-dir|run.json> <candidate-run-dir|run.json>`：对比两个 eval run 的通过率、分数、进度、token 和成本变化。
- `q-code eval promote <run-dir|run.json> --as <baseline-name>`：把一次 run 保存为 `.q-code/evals/baselines/<name>/` 命名 baseline。
- `q-code eval trend [--suite <name>] [--limit N] [--runs-dir <dir>] [--out <dir>]`：聚合历史 run，写出 `.q-code/evals/trends/trend.json` 与 `trend.md`。

主交互循环还接受以下启动参数：`--continue`、`--session <id>`、`--plan`、`--agent-teams`、`--classic`、`--debug`、`--dump-system-prompt`。内置 Slash 含 `/ya [list|yellow|shanghai|heilongjiang|toggle]`（别名 `/duck`）；TUI 下 `/ya` 或 `/ya list` 打开鸭子选择器（↑/↓ + Enter），默认 `yellow`（小黄鸭）。

## 目录边界

- `src/index.ts`：CLI 启动、交互循环、模式切换、上下文压缩调度和整体编排。
- `src/agent/`：核心 Agent Loop、重试、循环检测、模型等待心跳与单步模型请求超时。
- `src/agents/`：SubAgent、后台 Agent、Agent Teams、worktree、mailbox、notification-store。
- `src/context/`：System Prompt 管道、鸭子人格（`duck-persona.ts`，主题鸭通过本轮 transient 用户消息注入，不进 system prompt / 会话历史）、上下文压缩与 offload、Plan Mode 附件/计划文件/意图识别、任务、Todo、记忆、运行环境和项目指令加载。
- `src/tools/`：内置工具定义、注册表（含审计/Hooks 包装层）、自定义工具目录加载器、文件/搜索/计划/任务/团队/Memory/Skill/GitLab KB/Agent 等工具；`shell-tools.ts` 负责 `f`、后台 shell job、输出 spill、cwd 策略和危险命令/交互保护。
- `src/mcp/`：MCP 配置、连接、工具适配和注册表。
- `src/skills/`：Skills 加载、预算、条件激活和斜杠命令展开。
- `src/slash/`：斜杠命令注册表、解析、suggestions、formatHelp（`/help` 输出由此驱动）。
- `src/hooks/`：Pre/Post tool-use Hooks 的配置加载、matcher、command-runner 与 DefaultHookRunner。
- `src/observability/`：NDJSON 审计日志（`audit.ts`）、可选 Langfuse/OpenTelemetry 导出（`langfuse.ts`，含 Agent step TTFT/吞吐/等待状态 attributes）与 `q-code audit verify|tail` 子命令实现（`audit-cli.ts`）。
- `src/evals/`：Agent eval 子系统，包含 case loader、mock/cli-subprocess/real-agent runner、trace recorder、deterministic scorers、LLM judge、报告、Langfuse eval trace/dataset/scores 导出、趋势看板与 `q-code eval` CLI。
- `src/runtime/`：早期 CLI 子命令路由（help/version/update/audit/init/eval）、`init-cli` 交互式配置向导、通用 reasoning 配置与 DeepSeek reasoning 兼容层、Shell 启动参数与 Windows PowerShell fallback、颜色环境 bootstrap、`getPackageVersion`、`runCliUpdate`、启动更新说明（`changelog.ts`）、`installCrashGuard` 与崩溃报告生成。
- `src/config/`：`runtime-config.ts` 负责加载 `~/.q-code/config.toml`、`<cwd>/.q-code/config.toml`、`.env`，统一映射到 `process.env`（支持多 section/alias）。
- `src/session/`：`SessionStore`（JSONL append-only、metadata、trash/restore、export/search、cache 模式与 usage 记录持久化）。
- `src/mentions/`：`@file` 文件引用解析、git/递归文件索引、项目级候选缓存与 watcher 刷新 store、fuzzy 排序、路径安全校验、文件内容截断和本轮上下文注入。
- `src/usage/`：token 归一化、定价、cache 策略、`UsageTracker` 与 `/usage` 渲染。
- `src/infra/`：企业 AI 基建配置同步（base URL / token / sync 状态 / 知识候选上报）。
- `src/gitlab-kb/`：GitLab Wiki 知识库读取/搜索/发布（`/gitlab-kb` 命令背后逻辑）。
- `src/terminal/`：Ink TUI、输入状态机、Plan Mode 入口建议确认面板、SubAgent Monitor（`agent-monitor.ts` 负责排序、tail output 与格式化）、输入历史 JSONL 持久化（`history-store.ts`）、事件流、Markdown 块级/行内语义渲染、表格、主题（`theme/`）、24-bit 代码高亮、布局/光标 utils。
- `src/utils/`：通用工具（logger、原子写、字符串、环境变量布尔判定等）。
- `tests/unit/`：低成本单元测试。
- `tests/integration/`：跨模块行为验证（agent-loop、session-recovery、task-graph、audit-trail、team-flow 等）。
- `tests/_helpers/`：测试通用 helpers（mock-model、mock-tool、temp-home）。
- `src/scripts/test-*.ts`：legacy 端到端/冒烟脚本（MCP、Skills、Agents、AsyncAgents、Teams、Infra Candidate）。

## 实现约定

- 优先延续现有函数式模块风格和具名导出方式。
- 代码注释保持克制，只解释复杂流程或非显然约束。
- **源码文档**：`src/` 生产模块在文件头写模块级中文说明；对外导出符号配 JSDoc（以当前实现为准，不写推测性措辞）；复杂流程可加少量行内「为何」注释。约定详见 README「源码文档约定」；`tests/`、`dist/` 等目录不在此要求内。
- 修改用户可见行为时，同步更新 README 中对应命令、架构、环境变量或工作流说明。
- 主会话不再支持 `TOKEN_BUDGET` 与 `MAX_STEPS` 环境变量硬限制；如需防 runaway，优先依赖上下文 blocking、循环检测、显式 `AbortSignal`、子 Agent `maxTurns` 或 eval case 的局部预算。
- Eval 默认本地优先，artifact 写 `.q-code/evals/runs/<run-id>/`；Langfuse 仅为可选外部后端，trace/dataset/scores 导出失败不得让本地 eval 失败。CI 脚本优先使用 deterministic smoke/cli eval、case 过滤、运行级资源闸门与 JUnit 报告；trajectory scorer 应优先用 `requiredTools`、`forbiddenTools`、`maxExtraTools` 和 `expectedSteps` 做确定性覆盖；预算 scorer 要覆盖 steps/tools/duration/tokens/cost，成本按 `src/usage/pricing.ts` 估算；safety scorer 要覆盖泄密、禁止输出/工具输入/工具输出模式和禁止路径；`cli-subprocess` case 必须使用隔离 fixture/workspace 并声明期望副作用；`real-agent` 默认只暴露只读工具，写入/shell 工具必须在 `real.tools` 显式列出；真实模型和 LLM judge 必须 CLI opt-in。命名 baseline 写 `.q-code/evals/baselines/<name>/`，趋势看板写 `.q-code/evals/trends/`，都不要纳入提交。
- **新增/移除模块、目录、CLI 子命令、Slash 命令、Hook 事件、环境变量、测试脚本或协作约定时，必须同步改写本 `AGENTS.md`**，按以下对应关系补充：
  - 新模块/新顶层目录 → `## 目录边界`
  - 新 npm script / 新 legacy 脚本 → `## 常用命令`
  - 新 `q-code <subcommand>` 或新启动参数 → `## CLI 子命令`
  - 新核心能力（如 Plan Mode 同级特性） → `## 项目概览`
  - 新代码/写文件/审计/安全约定 → `## 实现约定`
  - 新测试套件或专项跑法 → `## 测试策略`
  - PR 中没改 `AGENTS.md` 的新功能，视为未完成；评审优先回退或要求补全。
- 鸭子人格默认「小黄鸭」不进 system prompt（保持 system/tools 前缀稳定）；`/ya` 选中主题鸭时通过 Agent Loop 的 `transientMessages` 作为本轮请求尾部用户消息注入，不进入 system prompt pipe，也不写入会话历史或压缩快照。
- 文件和会话持久化逻辑优先使用项目已有的原子写入、路径计算和存储 helper（如 `SessionStore`、`Q_CODE_HOME` 解析、`auditDir` 解析），避免临时拼接路径。
- Prompt、工具描述、项目说明多为中文；新增用户可见文案时优先保持中文一致性。
- 新增环境变量需同时更新：(a) `.env.example`；(b) `src/config/runtime-config.ts` 的 `SECTION_ALIASES`（让 toml 配置可用）；(c) README 配置表。
- 模型等待诊断通过 `Q_CODE_MODEL_WAIT_HEARTBEAT_MS` / `Q_CODE_MODEL_SLOW_REQUEST_WARN_MS` / `Q_CODE_MODEL_STALLED_REQUEST_WARN_MS` 控制 10/30/60s 首 token 心跳；`Q_CODE_MODEL_REQUEST_TIMEOUT_MS` 控制单步模型请求总超时（默认 0/未设置为不启用），错误提示必须只包含脱敏 endpoint，不得包含 API key。
- Plan Mode 语义入口由 `Q_CODE_PLAN_INTENT=auto|suggest|off` 控制，默认 `auto`。pending plan 的自然语言审批必须先走本地 deterministic fast-path、否定词优先、保守批准；本地 unknown 时可用当前会话模型做短超时 JSON intent judge 兜底（`Q_CODE_PLAN_INTENT_MODEL_TIMEOUT_MS`，默认 3000ms，0 关闭），模型失败、超时或低置信度必须回退 unknown。复杂执行型任务只建议进入 Plan Mode，不得静默强制切换；TUI 可显示确认面板保留原请求，Enter 进入 Plan 后继续，Esc 按普通模式执行，Ctrl+C 取消且不执行；classic readline 只提示并继续当前请求。修改相关逻辑需覆盖 `tests/unit/plan-intent.test.ts`、`tests/unit/terminal.test.ts` 并同步 README、`.env.example`、`AGENTS.md`、`src/config/runtime-config.ts`。
- Agent Loop 必须保留 AI SDK reasoning part（如 DeepSeek thinking/reasoner 的 `reasoning_content`）并随 assistant 消息回传给后续模型请求；`Q_CODE_MODEL_PROVIDER` / `Q_CODE_THINKING_TYPE` / `Q_CODE_REASONING_EFFORT` 是通用 reasoning 配置，主 Agent、SubAgent、摘要压缩、real-agent eval 与 LLM judge 都应统一接入。OpenAI 官方 provider 通过 `providerOptions.openai.reasoningEffort` 接收；DeepSeek 命中或显式设置 `Q_CODE_MODEL_PROVIDER=deepseek-compatible` 时走官方 `@ai-sdk/openai-compatible` provider 和 `src/runtime/deepseek-compat.ts` 请求体兼容层；`Q_CODE_REASONING_EFFORT=none` 对 DeepSeek 应关闭 thinking，不能回退为高强度推理。DeepSeek V4 Pro thinking + tools 只可静默移除默认 `tool_choice=auto`，显式 `required` 或指定函数必须报清晰错误，避免吞掉调用意图。reasoning 不作为普通 `onText` 文本输出到 TUI。
- 工具默认通过 `ToolRegistry.toAISDKFormat` 包装，会自动写 `tool.call` / `tool.result` 审计事件；新增工具入口或绕过 registry 时需自行接审计与 Hooks 管线（参考 `src/observability/audit.ts::getAuditLogger`）。
- `@file` mention 默认只能引用当前工作目录内文件，并必须校验 symlink 解析后的真实路径；绝对路径必须显式设置 `Q_CODE_MENTION_ALLOW_ABS=true`，并写 `user.mention` 审计事件。单文件/总附件预算变更需同步 README 和 `src/mentions/file-mentions.ts` 常量。TUI 候选索引缓存写入 `<cwd>/.q-code/file-mention-index.json`，启动可先使用旧缓存并后台刷新；watcher/刷新失败不得阻塞输入，需保留旧索引并显示简短提示。非 git fallback walk 的额外忽略目录通过 `Q_CODE_FILE_INDEX_IGNORE` 配置。
- 文件工具的读类入口（`read_file` / `list_directory` / `glob` / `grep`）可只读访问用户级 q-code 信任目录：`~/.q-code`、`~/.agents/skills`、`~/.agents/agents`；写入和编辑仍必须限制在当前 `cwd` 内。Windows 下路径比较必须兼容盘符大小写与分隔符差异。不要恢复全局 `Q_CODE_ALLOW_OUTSIDE_CWD` 式开关。
- Shell 工具默认只能在当前 `cwd` 内执行；跳出目录必须显式设置 `Q_CODE_SHELL_ALLOW_ABS_CWD=true`。长命令优先使用 `timeoutMs` 或 `background=true`，超大输出通过 `<Q_CODE_HOME>/shell-spills` 恢复全文，后台 job 元数据写 `<Q_CODE_HOME>/shell-jobs`。
- TUI 输入历史默认写入 `<cwd>/.q-code/history.jsonl` 与 `<Q_CODE_HOME>/history/global.jsonl`（由 `Q_CODE_HISTORY_SCOPE=project|global|both` 控制），必须过滤空格开头、连续重复和默认敏感 pattern（除非 `history.excludeDefaults=false`）；`Q_CODE_HISTORY_REDACT=true` 时不得保存完整输入原文。
- TUI 输入光标由 `Q_CODE_TUI_CURSOR=auto|ansi|inline|off` 控制；auto 下 VSCode、Cursor、Windsurf、Trae、JetBrains/IntelliJ IDEA 等 IDE 集成终端默认使用 inline 块光标，避免 ANSI 光标同步错位、闪烁或抖动。修改相关逻辑需覆盖 `src/terminal/cursor-mode.ts` 单测。
- 自定义工具目录固定为 `~/.q-code/tools/<name>/` 与 `<cwd>/.q-code/tools/<name>/`；项目级覆盖用户级，用户级覆盖内置工具。每个工具目录必须提供 `schema.json`，其结构为 `Omit<ToolDefinition, 'isEnabled' | 'execute'> & { execute: string }`，其中 `execute` 会在该工具目录下作为 shell 命令运行。
- Skills 目录支持 `~/.q-code/skills/<name>/SKILL.md`、`~/.agents/skills/<name>/SKILL.md`、`<cwd>/.q-code/skills/<name>/SKILL.md` 与 `<cwd>/.agents/skills/<name>/SKILL.md`；同名优先级为项目级 `.agents/skills` > 项目级 `.q-code/skills` > 用户级 `.agents/skills` > 用户级 `.q-code/skills`。
- 新增 Slash 命令通过 `createSlashCommandRegistry` + `command(...)` 注册（见 `src/index.ts::createBuiltinSlashCommands`），并填好 `category`、`aliases`、`usage`，以便 `/help` 输出友好。
- 新增 Hook 事件类型时同步更新 `src/hooks/events.ts` 与 `src/hooks/types.ts` 的导出，并在 `tests/unit/hooks.test.ts` 加覆盖。
- 新增企业/外部观测相关能力（Infra / GitLab KB / 审计 PII 模式 / Langfuse）必须保持可禁用：环境变量缺省值不能让首次启动失败。Langfuse 默认关闭，且 `Q_CODE_LANGFUSE_RECORD_IO` 默认不得上传 prompt、文件内容、shell 输出或工具结果原文。
- 崩溃保护默认开启，新增崩溃处理逻辑必须避免依赖 Ink 输出；用户提示走裸 `stderr.write`，报告默认写 `<Q_CODE_HOME>/crashes`，测试里使用 `register: false` 和 mock `exit`。
- TypeScript 严格模式 + `moduleResolution: bundler` + `target: ES2022`；优先使用 `import type`、避免 `any`，公共边界用具名 interface。
- 不要将 `.sessions/`、`.q-code/`（含 `.q-code/logs/`、`.q-code/crashes/`、`.q-code/agents/`、`.q-code/skills/`）、`node_modules/`、`dist/`、覆盖率输出或本地 `.env` 纳入提交。

## 测试策略

- 小型纯逻辑改动：至少运行 `pnpm test:unit`，必要时指定相关测试文件，例如：
  - 审计日志改动：`vitest run tests/unit/audit-logger.test.ts tests/integration/audit-trail.test.ts`
  - Hooks 改动：`vitest run tests/unit/hooks.test.ts`
  - Slash 改动：`vitest run tests/unit/slash.test.ts`
  - Tool registry 改动：`vitest run tests/unit/tool-registry.test.ts`
  - 文件/读写工具改动：`vitest run tests/unit/file-tools.test.ts tests/unit/tool-registry.test.ts`
  - Shell 工具改动：`vitest run tests/unit/shell-tools.test.ts tests/integration/shell-streaming.test.ts`
  - 自定义工具目录改动：`vitest run tests/unit/custom-tools.test.ts tests/unit/tool-registry.test.ts`
  - `@file` 文件引用：`vitest run tests/unit/file-mentions.test.ts tests/unit/file-index-cache.test.ts tests/unit/terminal.test.ts tests/unit/runtime-config.test.ts`
  - 会话管理：`vitest run tests/unit/session-management.test.ts tests/integration/session-recovery.test.ts tests/integration/session-switch.test.ts tests/unit/terminal.test.ts`
  - Plan Mode 意图识别：`vitest run tests/unit/plan-intent.test.ts tests/unit/runtime-config.test.ts tests/unit/terminal.test.ts`
  - 终端/输入状态机改动：`vitest run tests/unit/terminal.test.ts`
  - TUI SubAgent Monitor：`vitest run tests/unit/agent-monitor.test.ts tests/unit/terminal.test.ts`
  - TUI 输入历史：`vitest run tests/unit/history-store.test.ts tests/unit/terminal.test.ts tests/integration/history-flow.test.ts`
  - 运行时配置/CLI 子命令：`vitest run tests/unit/runtime-config.test.ts tests/unit/cli-info.test.ts tests/unit/update.test.ts tests/unit/changelog.test.ts tests/unit/init-cli.test.ts`
  - 鸭子人格 / system prompt：`vitest run tests/unit/duck-persona.test.ts tests/unit/prompt-builder.test.ts`
  - 崩溃保护：`vitest run tests/unit/crash-guard.test.ts tests/unit/mcp-bootstrap.test.ts tests/unit/audit-logger.test.ts`
  - Infra / GitLab KB：`vitest run tests/unit/infra.test.ts tests/unit/infra-candidate.test.ts tests/unit/gitlab-kb.test.ts`
  - Agent 工具/SubAgent 参数传递与只读并行调度：`vitest run tests/unit/agent-tools.test.ts tests/integration/audit-trail.test.ts`
  - Eval 框架：`vitest run tests/unit/evals.test.ts tests/unit/cli-info.test.ts`，必要时运行 `pnpm eval:smoke`、`pnpm eval:cli`、`pnpm eval:trend`；Langfuse 连通性可跑 `pnpm eval:smoke:langfuse`
- 类型、接口或公共工具改动：运行 `pnpm typecheck`。
- 涉及 Agent Loop、上下文、会话恢复、任务图、团队协作或审计端到端：运行 `pnpm test` 或相关 `tests/integration/**`（含 `agent-loop`、`session-recovery`、`task-graph`、`team-flow`、`audit-trail`）。
- 涉及 MCP、Skills、Agents、Teams 或 worktree 端到端行为：运行对应 `pnpm test:mcp`、`pnpm test:skills`、`pnpm test:agents`、`pnpm test:teams`、`pnpm test:infra-candidate`，必要时运行 `pnpm test:legacy`。

## Git 与提交注意

- 当前主分支是 `main`。
- 工作区可能存在用户改动；修改前先查看状态，避免覆盖不相关变更。
- pre-commit hook 由 `simple-git-hooks` 安装，默认执行 `pnpm precommit`。
- 只有在用户明确要求时才跳过 hook 或执行提交。
- 发现值得提issue的想法时，可以直接提到github issue中
