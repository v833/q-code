# SubAgent 与 Agent Teams

读者对象：需要改 `Agent` 工具、后台 Agent、Agent Teams 或 TUI Monitor 的人。

## SubAgent

SubAgent 是独立上下文里的子任务。主 Agent 用 `Agent` 工具发起，子 Agent 使用过滤后的工具集运行同一套 Agent Loop。

主要文件：

- `src/tools/agent-tools.ts`
- `src/agents/run-agent.ts`
- `src/agents/run-async-agent.ts`
- `src/agents/async-agent-store.ts`
- `src/agents/task-output.ts`
- `src/agents/final-output-artifact.ts`

## 后台运行

后台 SubAgent 会写 JSONL 输出文件，完成后进入通知队列。下一轮用户输入前，主会话收到 `<task-notification>`。

长 final output 不直接塞回主上下文，而是写入 artifact，返回 preview 和路径。

## Agent Teams

Agent Teams 在 SubAgent 基础上增加命名队友和邮箱通信。适合长期并行协作，但默认关闭，需要 `--agent-teams` 或 `Q_CODE_TEAMS=1`。

## TUI Monitor

`/agents` 打开 SubAgent Monitor。它展示运行状态、最近工具、token、耗时和输出 tail。
