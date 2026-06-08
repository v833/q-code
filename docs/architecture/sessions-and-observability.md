# 会话与可观测性

读者对象：需要改会话恢复、审计、usage、Langfuse 或崩溃报告的人。

## 会话

`SessionStore` 使用 JSONL 保存消息和 metadata。它支持：

- 新建、恢复、切换会话。
- 损坏 JSONL 行容错。
- usage 和 cache 记录。
- trash/restore/export/search。

恢复会话只恢复上下文，不决定之后使用哪个模型。

## 审计

审计默认开启，记录：

- session start/resume/end。
- user prompt 摘要。
- agent step start/end。
- tool call/result。
- hook decision。
- subagent/team/context/error 事件。

默认不写 prompt、文件内容、shell 输出或工具结果原文。

## Langfuse

Langfuse 是可选外部导出。默认关闭，且 `Q_CODE_LANGFUSE_RECORD_IO` 默认不上传原文。

## Dashboard

`q-code dashboard` 提供本地只读 Web UI。它读取：

- `.sessions/projects/*/*.jsonl` 会话和 usage。
- `<Q_CODE_HOME>/logs/audit-*.ndjson` 审计事件。
- `.sessions/projects/*/tasks/**` Task V2 静态任务图。
- `.sessions/projects/*/async-agents/**` 和 `agent-artifacts/**` 后台 Agent artifact。
- `.q-code/evals/**` eval run、baseline 和 trend artifact。

Dashboard 默认绑定本机地址，`--host` 只接受 loopback 地址。页面和 API 只展示摘要、哈希、计数、token 与成本，不返回本机绝对路径，也不渲染 prompt、文件内容、shell 输出或工具结果原文。

## 崩溃报告

crash guard 默认开启。报告写入 `<Q_CODE_HOME>/crashes`，不要依赖 Ink 渲染错误。
