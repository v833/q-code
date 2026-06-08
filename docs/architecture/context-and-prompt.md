# 上下文与 Prompt

读者对象：需要改 system prompt、项目指令、压缩或任务上下文的人。

## 两类上下文

| 类型 | 放什么 | 原因 |
| --- | --- | --- |
| 稳定 system prompt | 核心规则、项目运行纪律、稳定工具纪律、稳定行为正反例、稳定 Skill/SubAgent 提醒 | 尽量保持 prompt cache 命中 |
| transient user context | 当前日期、Git 摘要、可见 Skill、任务状态、会话信息、Output Style、鸭子人格 | 每轮会变，不污染稳定前缀 |

## 重要模块

- `src/context/prompt-builder.ts`：Prompt 管道；主 Agent 和 SubAgent 复用共享稳定 pipe，SubAgent 只在项目指令后插入角色说明。
- `src/context/runtime-context.ts`：运行环境摘要。
- `src/context/compressor.ts`：上下文压缩。
- `src/context/offload.ts`：大内容落盘。
- `src/context/tasks.ts`：Task V2 持久化任务图。
- `src/context/agent-md.ts`：AGENT/AGENTS 指令加载；短文件原样注入，长文件只保留运行纪律摘要和章节索引。

## 改动原则

- 新增 prompt pipe 要标明稳定性和类别。
- 主 Agent / SubAgent 的共同纪律优先放进共享稳定 pipe，避免两套 prompt 漂移。
- 日期、Git 状态、动态工具数量不要塞进稳定前缀。
- Output Style 属于动态上下文；切换风格不能改变稳定 system prompt hash。
- 修改 prompt/cache 逻辑后，运行相关 prompt 和 agent-loop 测试。
