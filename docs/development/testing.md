# 测试

读者对象：准备验证改动的人。

## 最常用

```bash
pnpm typecheck
pnpm test:unit
pnpm precommit
```

## 分层

| 命令 | 说明 |
| --- | --- |
| `pnpm test:unit` | 只跑单元测试，适合本地快验 |
| `pnpm test:integration` | 跑跨模块流程 |
| `pnpm test` | unit + integration |
| `pnpm test:legacy` | MCP、Skills、Agents、Teams 冒烟 |
| `pnpm test:all` | 全量测试 |
| `pnpm eval:smoke` | deterministic Agent eval |
| `pnpm eval:cli` | CLI fixture eval |

## 怎么选

- 改纯函数：跑对应单测。
- 改工具注册、文件、shell：跑相关 `tests/unit/*tools*`。
- 改 Agent Loop、上下文、会话：跑 integration。
- 改 SubAgent 或 Agent Teams：跑 `pnpm test:agents` 或 `pnpm test:teams`。
- 改 eval：跑 `pnpm eval:smoke`，必要时 `pnpm eval:cli`。
- 改 Dashboard：跑 `vitest run tests/unit/dashboard-data.test.ts tests/integration/dashboard-flow.test.ts tests/unit/cli-info.test.ts`。
- 改文档站：跑 `pnpm docs:build`。

## 降低 flaky

- 测试写入临时目录。
- 不依赖真实用户 home。
- 真实模型和 LLM judge 必须显式 opt-in。
- Langfuse 导出失败不能让本地 eval 失败。
