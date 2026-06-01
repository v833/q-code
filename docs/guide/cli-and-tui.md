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
| `q-code eval ...` | 运行 Agent eval |

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
