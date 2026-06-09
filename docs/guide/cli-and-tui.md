# 命令行与 TUI

q-code 默认进入 Ink TUI。非 TTY、管道或 `--classic` 会使用经典 readline。

## 启动

```bash
q-code
q-code --continue
q-code --session <id>
q-code --plan
q-code --agent-teams
```

## 早期子命令

这些命令会在进入主循环前执行：

| 命令 | 说明 |
| --- | --- |
| `q-code help` | 打印帮助 |
| `q-code version` | 打印版本 |
| `q-code update` | 更新全局安装 |
| `q-code init` | 初始化配置 |
| `q-code audit verify` | 校验审计日志 |
| `q-code audit tail` | 查看审计日志 |
| `q-code dashboard` | 启动本地只读 Web Dashboard |
| `q-code eval ...` | 运行 Agent eval |

`q-code dashboard` 默认绑定 `127.0.0.1:48888`，`--host` 只接受 loopback 地址，读取本地 session、audit、Task V2、SubAgent artifact 和 eval artifact。页面只展示摘要、哈希、计数、token 与成本，不上传数据，不返回本机绝对路径，也不渲染 prompt 或工具输出原文。

## TUI 常用入口

| 入口 | 说明 |
| --- | --- |
| `/sessions` | 管理会话 |
| `/agents` | 查看 SubAgent Monitor |
| `/tasks` | 切换 Task V2 / TodoWrite |
| `/mode plan` | 进入 Plan Mode |
| `/ya` | 切换小黄鸭人格 |
| `@file` | 引用仓库文件 |

TUI 负责显示模型输出、工具调用、token 用量、上下文状态和 SubAgent 进度。重活尽量交给工具和 SubAgent，主对话只保留摘要。

流式 assistant Markdown 使用“稳定前缀 + 纯文本尾巴”策略：已经越过空行边界且语法闭合的前缀使用完整 Markdown 语义渲染，正在输出的最后一段或未闭合代码块保持纯文本，避免半成品 `**粗体**`、inline code、fenced code block 在 streaming 阶段反复重排。普通纯文本会通过 Markdown signal 快路径跳过 parser，重复 Markdown 文本会命中有界 LRU parse cache，以降低长会话回看和 Static transcript 重渲染成本。
