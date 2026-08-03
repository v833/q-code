# Codex CLI 兼容模式设计

## 背景

`agent-os` 通过无头子进程调用 Codex CLI，首次请求使用
`codex exec --json --full-auto --skip-git-repo-check <prompt>`，续聊使用
`codex exec resume <thread_id> --json --full-auto --skip-git-repo-check <prompt>`。
它从 stdout 逐行读取 JSONL，并依赖 `thread.started`、工具 `item.*`、最终
`agent_message`、`turn.completed` 和失败事件。

本次只修改 `q-code`。完成后由 `agent-os` 选择 q-code 可执行入口，不在本次
改动中修改或劫持本机的 `codex` 命令。

## 目标

- 新增与 Codex 常用无头调用兼容的 `q-code exec` 和 `q-code exec resume`。
- stdout JSONL 可直接被 `agent-os` 的 Codex 事件适配器消费。
- 交互 CLI 与 exec 复用同一个会话、工具、Prompt、Hooks、Skills、MCP、记忆、
  压缩和 Agent Loop Runtime，避免两套行为漂移。
- 支持常用工作目录、模型、图片、stdin、最终消息文件和 ephemeral 参数。
- 保持现有 TUI、classic readline、Slash 命令和会话恢复行为不变。

## 非目标

- 不实现 Codex 的完整配置系统、审批系统或 OS 级 sandbox。
- 不修改 `C:\Users\25073\Desktop\agent-os`。
- 不提供或覆盖名为 `codex` 的系统可执行文件。
- 不兼容 `review` 等本次接入不需要的 Codex 子命令。

## 总体架构

### 共享 ConversationRuntime

从 `src/cli/main.ts` 抽取与界面无关的共享 Runtime。它负责：

- 模型初始化与本进程模型覆盖；
- SessionStore、消息历史、usage 和模型边界提示；
- 内置/自定义工具、MCP、Hooks、Skills、Agents 和 Agent Teams 初始化；
- System Prompt、动态 transient context、mentions、图片附件和项目记忆；
- 单轮 Agent Loop、文件历史、Task/Todo、压缩和停止 Hook；
- 当前轮取消、资源关闭和会话切换。

Runtime 使用函数式构造器和具名接口，不依赖 Ink、readline 或 Codex JSONL：

```ts
interface ConversationRuntime {
  initialize(): Promise<void>
  runTurn(input: ConversationTurnInput): Promise<ConversationTurnResult>
  switchSession(sessionId: string): Promise<void>
  abort(reason?: unknown): void
  close(): Promise<void>
}
```

Runtime 通过中立事件汇报 session、turn、assistant、tool、usage、status 和 error。
事件只表达 q-code 运行语义，不包含 Codex 专属字段。

### 交互适配层

`src/cli/main.ts` 保留 TUI/readline 输入、Slash 命令、选择器和终端展示。它订阅
Runtime 事件并映射为现有 `TerminalEvent`，通过 Runtime 方法完成普通对话、
session switch、模型切换、压缩和取消。

只抽取交互与 exec 确实共享的初始化、单轮执行、持久化和关闭流程。TUI 专属展示
和 Slash 命令解析不做无关重构。

### Exec 适配层

新增 `src/cli/exec-cli.ts`，负责：

- 解析 Codex 风格参数；
- 在加载项目配置前应用 `-C/--cd`；
- 读取 prompt、stdin 和图片；
- 创建或恢复 Runtime 会话；
- 运行一轮并设置退出码；
- 将最终回答写入 `-o/--output-last-message`。

新增 `src/cli/codex-jsonl.ts`，只负责把中立 Runtime 事件翻译成 Codex JSONL。
JSONL 格式变化不会进入 Runtime 或交互适配层。

`src/cli/bootstrap.ts` 把 `exec` 作为 early command 动态加载，保证 help/version 的
轻启动约束不被破坏。

## CLI 契约

### 命令

```text
q-code exec [OPTIONS] [PROMPT]
q-code exec resume [OPTIONS] <SESSION_ID> [PROMPT]
q-code exec resume --last [OPTIONS] [PROMPT]
```

参数可以按 Codex/`agent-os` 当前使用的顺序出现在 session id 与 prompt 前后。
`--` 结束参数解析，其后内容只作为 prompt 位置参数。

### 支持参数

| 参数 | q-code 语义 |
| --- | --- |
| `--json` | stdout 仅输出 UTF-8 JSONL |
| `-C, --cd <DIR>` | 在配置、AGENTS.md、Skills 和会话初始化前切换工作目录 |
| `-m, --model <MODEL>` | 仅覆盖当前进程使用的模型，不读取历史模型作为执行模型 |
| `-i, --image <FILE>` | 可重复，复用现有图片路径安全和预算规则 |
| `-o, --output-last-message <FILE>` | 成功后原子写入最终 assistant 消息 |
| `--color always\|never\|auto` | 控制文本模式；JSON 模式始终无 ANSI |
| `--ephemeral` | 使用内存会话，不生成可恢复 transcript 或 latest 指针 |
| `--full-auto` | 非交互执行，保留 Hooks、危险命令保护和 cwd 边界 |
| `--skip-git-repo-check` | 安全 no-op；q-code 默认允许非 Git 工作目录 |
| `-s, --sandbox read-only` | 只开放现有只读工具 |
| `-s, --sandbox workspace-write` | 使用 q-code 现有 cwd 写入和 shell cwd 保护 |
| `-h, --help` | 输出 exec 或 resume 帮助并退出 |
| `-V, --version` | 输出版本并退出 |

这里的 sandbox 是工具可见性和路径边界策略，不宣称提供 Codex 的 OS 级隔离。
文档和帮助必须明确这一差异。

### 明确拒绝的参数

首期对以下参数返回参数错误，不静默忽略：

- `--sandbox danger-full-access`
- `--dangerously-bypass-approvals-and-sandbox`
- `--add-dir`
- `--output-schema`
- `--oss` / `--local-provider`
- `-p/--profile`
- `-c/--config`
- `--enable` / `--disable`
- `exec review`
- `exec resume --all`

未知参数同样失败。参数错误退出码为 `2`。

### Prompt 与 stdin

- 有一个 prompt 位置参数时直接使用。
- prompt 缺失或为 `-` 时从 stdin 读取。
- 同时存在 prompt 和管道 stdin 时，将 stdin 作为 `<stdin>` 块追加到 prompt。
- 空 prompt 失败，不启动 Runtime。
- prompt 始终作为独立 argv 或 stdin 数据处理，不经过 shell 拼接。

## 会话语义

- 首次 `exec` 创建正常 q-code session，并把 session id 作为 `thread_id`。
- `exec resume <id>` 只恢复当前 `-C` 工作目录对应的已有 session。
- 不存在、已损坏或属于其他项目的 session id 失败，不静默创建新会话。
- `resume --last` 使用目标工作目录最新的有效 session。
- 恢复后的新请求继续使用当前 runtime effective model 或 `--model` 覆盖；历史
  metadata model 只用于展示、审计和 usage。
- `--ephemeral` 使用进程内消息存储，不更新 latest session，不能 resume。
- ephemeral 不改变工具产生的目标文件；审计仍遵循 q-code 现有开关和脱敏规则。

## Runtime 数据流

每轮按固定顺序执行：

```text
user_prompt_submit Hook
  -> @file / @image 与 CLI 图片附件
  -> 持久化用户消息（ephemeral 时仅内存）
  -> 构建稳定 system prompt 与 transient context
  -> Agent Loop / 工具执行 / usage
  -> 持久化 assistant 与 tool 消息
  -> memory 与 post-turn compaction
  -> stop Hook
  -> ConversationTurnResult
```

同一 Runtime 同时只允许一个 `runTurn`。最终回答从最后一条 assistant 消息提取，
不通过拼接所有流式文本推断，避免把中间 tool-call step 文本当成最终结果。

## Codex JSONL 映射

JSON 模式 stdout 不允许 banner、ANSI、启动日志或非 JSON 行。诊断信息写 stderr。

成功事件顺序：

```jsonl
{"type":"thread.started","thread_id":"<q-code-session-id>"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"<tool-call-id>","type":"command_execution","command":"...","status":"in_progress"}}
{"type":"item.completed","item":{"id":"<tool-call-id>","type":"command_execution","command":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"<message-id>","type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0}}
```

工具映射规则：

- `f` 与 shell job 工具映射为 `command_execution`；
- `write_file` / `edit_file` 映射为 `file_change`；
- 其他内置、自定义和 MCP 工具映射为 `mcp_tool_call`，其中 `server` 为
  `q-code` 或实际 MCP server 名称；
- tool id 全程使用原始 tool call id，保证 started/completed 配对；
- 工具失败仍输出 `item.completed`，item status 为 `failed`，随后由 Agent Loop
  决定是否继续本轮。

初始化或参数阶段失败输出：

```json
{"type":"error","message":"<脱敏错误摘要>"}
```

已开始的轮次失败输出：

```json
{"type":"turn.failed","error":{"message":"<脱敏错误摘要>"}}
```

非 JSON 模式只把最终回答写 stdout，进度和诊断写 stderr。

## 失败、取消与关闭

- 参数/输入错误退出 `2`，运行失败退出 `1`，SIGINT/取消退出 `130`，成功退出 `0`。
- 初始化采用可回滚的资源栈；部分启动失败时逆序关闭已启动的 MCP、Hooks、trace
  和后台资源。
- `close()` 可重复调用，exec 入口必须在 `finally` 中调用。
- SIGINT 使用当前轮 AbortController 中止模型和工具调用，然后关闭 Runtime。
- stdout 管道出现 `EPIPE` 时中止当前轮并安静退出，不打印 Node 堆栈。
- endpoint 仅输出脱敏形式，任何错误路径都不得包含 API key。
- `-o` 写入失败视为本轮失败；使用项目已有原子写 helper，编码固定 UTF-8。

## 测试与验收

### 单元测试

- exec/resume 参数位置、短参数、重复图片、`--`、stdin 组合与冲突；
- 未知/不支持参数和缺失参数的错误及退出码；
- Runtime 中立事件到 Codex JSONL 的精确映射与事件顺序；
- shell、文件和其他工具的 item 类型及 started/completed 配对；
- JSON 序列化不包含 ANSI 或额外 stdout 文本；
- ephemeral store、resume missing、resume last 和跨项目隔离；
- `-C` 在项目配置与 AGENTS.md 加载前生效；
- model override 不被历史 metadata 覆盖。

### 集成测试

- 使用 mock model/tool 跑共享 Runtime，验证交互与 exec 取得相同最终消息、工具轨迹、
  usage、Hooks 和持久化结果；
- 子进程复刻 `agent-os` 首次参数，逐行解析 JSONL，取得非空 `thread_id` 和最终回答；
- 使用首次返回的 id 复刻 `agent-os` resume 参数，验证历史上下文被恢复；
- 验证工具事件、turn.completed、运行失败、取消和退出码；
- 验证 `--json` stdout 每一行都是 JSON，启动诊断只在 stderr；
- 验证 `-i`、stdin、`-o`、`-C`、`--ephemeral` 和 read-only 策略；
- 保留并运行现有 terminal、session recovery/switch、agent-loop、attachments、Hooks、
  tool registry、prompt builder 和 runtime config 回归测试。

### 完成标准

以下调用可被与 `agent-os` 当前 CodexAdapter 等价的解析器成功消费：

```text
q-code exec --json --full-auto --skip-git-repo-check <prompt>
q-code exec resume <thread_id> --json --full-auto --skip-git-repo-check <prompt>
```

解析器必须取得首次 `thread_id`、两轮最终回答、命令执行进度和完成 usage；进程成功
退出，stdout 无非 JSON 噪音。`pnpm precommit` 以及受影响的集成测试全部通过。

## 文档同步

实现时同步更新：

- `README.md`：命令、参数、JSONL、sandbox 差异和 `agent-os` 接入示例；
- `AGENTS.md`：项目概览、CLI 子命令、目录边界与测试策略；
- `src/runtime/cli-info.ts`：主帮助和 exec 帮助入口；
- 如未新增环境变量，不修改 `.env.example` 与 runtime config aliases。

