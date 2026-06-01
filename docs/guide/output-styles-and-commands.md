# Output Styles 与 User Commands

Output Styles 解决“每轮都要重复声明回答风格”的问题。User Commands 解决“常用长 prompt 没有快捷入口”的问题。

两者都是轻量扩展：

- Output Style：切换回答风格，作为本轮动态上下文注入，不进入稳定 system prompt。
- User Command：把 Markdown 模板映射成 `/命令 参数`，展开后按普通用户请求执行。

## Output Styles

内置风格：

| 风格 | 用途 |
| --- | --- |
| `default` | 默认行为，不追加额外风格指令 |
| `Explanatory` | 在关键实现选择处给简短 Insight |
| `Learning` | 面向教学练习，可留下 `TODO(human)` |

常用命令：

```bash
/output-style
/output-style list
/output-style Explanatory
/output-style default
```

自定义风格放在：

```text
~/.q-code/output-styles/<name>.md
<project>/.q-code/output-styles/<name>.md
```

项目级同名覆盖用户级，用户级同名覆盖内置。

示例：

```markdown
---
name: Concise
description: 极简风格，只说结论
keepCodingInstructions: true
---
回答尽量短。先给结论，再给必要命令或文件引用。
```

当前风格写在 `settings.json`：

```json
{
  "outputStyle": "Explanatory"
}
```

切换到项目级风格时，q-code 会优先写项目 `.q-code/settings.json`；否则沿用已有项目 settings，或写入用户级 settings。

## User Commands

命令文件位置：

```text
~/.q-code/commands/review.md       -> /review
~/.q-code/commands/git/sync.md     -> /git:sync
<project>/.q-code/commands/deploy.md -> /deploy
```

规则：

- 子目录转成 `:` 命名空间。
- 项目级命令覆盖用户级同名命令。
- 用户命令不能覆盖内置 Slash 命令。
- 命令名只允许字母、数字、下划线、短横线和冒号。

查看命令：

```bash
/commands
/commands doctor
```

`doctor` 会显示加载 warning，例如内置命令冲突、非法 frontmatter 或空模板。

## 命令模板

```markdown
---
description: Review 代码文件
argument-hint: <文件路径>
model: gpt-4.1-mini
allowed-tools: [read_file, grep, glob]
---
请帮我 review $ARGUMENTS 这个文件，重点关注：
1. 边界条件
2. 错误处理
3. 安全隐患
4. 性能问题
```

frontmatter：

| 字段 | 说明 |
| --- | --- |
| `description` | 补全、`/help`、`/commands` 中展示 |
| `argument-hint` | 参数提示 |
| `model` | 只影响本轮命令，不修改 `/model` 状态 |
| `allowed-tools` | 只在当前已可见工具中收窄本轮工具集 |

`allowed-tools` 不能绕过权限、Hooks 或危险命令保护。它只会减少本轮暴露给模型的工具。

## 参数替换

支持：

| 占位符 | 含义 |
| --- | --- |
| `$ARGUMENTS` | 全部参数原文 |
| `$1`、`$2` | 1-indexed 位置参数 |
| `$ARGUMENTS[0]` | 0-indexed 位置参数 |

参数支持简单引号：

```bash
/review "src/a b.ts" foo
```

若模板没有任何占位符，但用户传了参数，q-code 会在末尾追加：

```text
ARGUMENTS: <参数原文>
```

## 执行与审计

User Command 展开后会走普通 Agent Loop：

```text
/review src/foo.ts
  -> 读取 review.md
  -> 替换占位符
  -> 对展开后的 prompt 运行 user_prompt_submit Hook
  -> 注入 @file
  -> 进入 Agent Loop
```

审计事件只记录命令名、来源、是否指定 model、allowed-tools 数量，不记录完整模板正文。

## 与 Skills 的区别

| 能力 | 触发方式 | 适合 |
| --- | --- | --- |
| User Commands | 用户明确输入 `/命令` | 高频个人/项目 prompt 模板 |
| Skills | 模型按场景主动调用，或用户 `/<skill>` 触发 | 多步工作流、方法论、工具使用流程 |

如果只是把一段常用提示变短，用 User Commands。若需要模型在合适场景主动发现并读取完整流程，用 Skills。
