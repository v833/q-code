# Hooks

Hooks 把“请记得做安全检查、审计、测试”从提示词里拿出来，变成 Agent 生命周期里的确定性步骤。它适合做四类事：拦截危险操作、记录审计、质量门控、给本轮请求补充上下文。

配置文件有两个层级，都会加载：

- `~/.q-code/settings.json`：用户级，对所有项目生效。
- `<project>/.q-code/settings.json`：项目级，只对当前项目生效。

用户级先执行，项目级后执行。每个 Hook 按数组顺序串行运行。

## 生命周期事件

| 事件 | 触发时机 | 常见用途 |
| --- | --- | --- |
| `session_start` | 会话初始化后 | 启动审计 |
| `user_prompt_submit` | 用户输入展开为 `@file` / Skill 上下文前 | 改写 prompt、追加 Git 状态 |
| `pre_tool_use` | 工具执行前 | 阻止危险 shell/git 命令 |
| `post_tool_use` | 工具执行后 | 改写工具输出、记录结果 |
| `stop` | 主 Agent 本轮结束前 | 质量门控；block 后本轮保持 blocked 状态 |
| `session_end` | 会话结束时 | 收尾审计 |
| `subagent_start` | 子 Agent 启动前 | 子任务审计 |
| `subagent_stop` | 子 Agent 结束后 | 子任务结果审计 |

## 配置示例

```json
{
  "hooks": {
    "pre_tool_use": [
      {
        "name": "deny-dangerous-git",
        "matcher": { "tool": "f" },
        "command": "node docs/examples/hooks/deny-dangerous-git.js",
        "timeoutMs": 3000,
        "blocking": true
      }
    ],
    "user_prompt_submit": [
      {
        "name": "inject-git-status",
        "command": "node docs/examples/hooks/inject-git-status.js",
        "timeoutMs": 3000
      }
    ]
  }
}
```

`matcher.tool` 支持精确值、`*` 和正则字符串，例如 `read_file`、`*`、`write_file|edit_file`。

## 命令协议

q-code 会把单个 JSON payload 写入 Hook 命令的 stdin。payload 包含：

```json
{
  "id": "uuid",
  "event": "pre_tool_use",
  "sessionId": "session-1",
  "cwd": "/abs/project",
  "timestamp": "2026-06-01T12:00:00.000Z",
  "agent": { "kind": "main" },
  "hook": {
    "name": "deny-dangerous-git",
    "scope": "project",
    "sourcePath": "/abs/project/.q-code/settings.json"
  },
  "tool": {
    "name": "f",
    "toolCallId": "call-1",
    "input": { "command": "git push --force" }
  }
}
```

stdout 为空等价于放行。stdout 也可以输出 JSON 决策：

```json
{ "action": "continue" }
```

```json
{ "action": "warn", "message": "已记录本次工具调用" }
```

```json
{ "action": "block", "reason": "禁止 git push --force" }
```

```json
{
  "action": "modify",
  "prompt": "改写后的用户输入",
  "appendContext": "附加到本轮的运行上下文",
  "input": { "command": "pnpm test:unit" },
  "output": "改写后的工具输出",
  "message": "已按 Hook 规则改写"
}
```

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功；stdout 为空则 `continue`，stdout 为 JSON 则按 JSON 决策处理 |
| `2` | `block`；stderr 或 stdout 文本作为阻断原因 |
| `3` | `warn`；stderr 或 stdout 文本作为 warning |
| `4` | `modify`；stdout 必须是合法 JSON 且 `action` 为 `modify` |
| 其他 | 命令失败；`blocking=false` 时转 warning，否则阻断 |

stderr 只作为诊断信息，不会进入模型上下文。审计日志会记录 Hook 决策，但会走现有脱敏逻辑。

`user_prompt_submit` 的 `prompt` 改写会在普通输入的 `@file` 展开前生效，因此改写后的 prompt 仍会正常注入文件内容。若用户通过 `/skill` 调用技能且 Hook 改写了 prompt，q-code 会把改写后的内容当作普通输入执行，不再继续使用原 skill 展开结果。

## 示例脚本

仓库提供几个可复制的脚本：

- `docs/examples/hooks/deny-dangerous-git.js`：阻止危险 Git 命令。
- `docs/examples/hooks/inject-git-status.js`：给本轮 prompt 追加 Git 状态。
- `docs/examples/hooks/format-after-edit.js`：编辑后提示格式化。
- `docs/examples/hooks/stop-quality-gate.js`：在 `stop` 阶段做质量门控提示。

这些脚本默认只演示协议，不会替你改项目配置。复制到 `.q-code/hooks/` 后再在 `.q-code/settings.json` 中引用即可。
