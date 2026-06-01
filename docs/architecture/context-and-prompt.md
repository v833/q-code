# 上下文与 Prompt

读者对象：需要改 system prompt、项目指令、压缩或任务上下文的人。

## 两类上下文

| 类型 | 放什么 | 原因 |
| --- | --- | --- |
| 稳定 system prompt | 核心规则、项目指令、稳定工具纪律、稳定 Skill/SubAgent 提醒 | 尽量保持 prompt cache 命中 |
| transient user context | 当前日期、Git 摘要、可见 Skill、任务状态、会话信息、鸭子人格 | 每轮会变，不污染稳定前缀 |

## 重要模块

- `src/context/prompt-builder.ts`：Prompt 管道。
- `src/context/runtime-context.ts`：运行环境摘要。
- `src/context/compressor.ts`：上下文压缩。
- `src/context/offload.ts`：大内容落盘。
- `src/context/tasks.ts`：Task V2 持久化任务图。
- `src/context/agent-md.ts`：AGENT/AGENTS 指令加载。

## 改动原则

- 新增 prompt pipe 要标明稳定性和类别。
- 日期、Git 状态、动态工具数量不要塞进稳定前缀。
- 修改 prompt/cache 逻辑后，运行相关 prompt 和 agent-loop 测试。
