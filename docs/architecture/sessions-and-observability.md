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

## 崩溃报告

crash guard 默认开启。报告写入 `<Q_CODE_HOME>/crashes`，不要依赖 Ink 渲染错误。
