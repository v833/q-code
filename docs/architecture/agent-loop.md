# Agent Loop

读者对象：需要修改模型调用、工具执行或循环控制的人。

## 职责

`src/agent/loop.ts` 是核心循环。它负责：

- 把消息、system prompt、工具定义发给模型。
- 接收文本、reasoning、工具调用和 usage。
- 执行工具，再把结果交回模型。
- 处理中断、最大步数、重试和循环检测。

## 关键边界

- 模型创建不在 `agentLoop` 内，外层负责 provider、model 和 reasoning 配置。
- 工具执行通过 `ToolRegistry`，不要绕过审计和 Hook 管线。
- reasoning part 必须保留给后续模型请求，但不作为普通文本输出。
- 长工具结果和长 SubAgent final output 应句柄化，避免撑爆主上下文。

## 改动时先看

- `src/agent/loop.ts`
- `src/agent/retry.ts`
- `src/agent/loop-detection.ts`
- `src/tools/registry.ts`
- `tests/integration/agent-loop.test.ts`
