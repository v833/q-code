# 配置

q-code 的配置优先级从高到低：

1. 环境变量。
2. 项目 `.q-code/config.toml`。
3. 用户 `~/.q-code/config.toml`。
4. 项目 `.env`。
5. 内置默认值。

## 推荐配置文件

全局使用时，把模型配置放在 `~/.q-code/config.toml`：

```toml
[openai]
api_key = "<your-api-key>"
base_url = "https://api.openai.com/v1"
model = "gpt-5.4"

[summary]
model = "gpt-5.4"
```

项目里需要覆盖时，使用 `.q-code/config.toml`。

## 常用环境变量

| 变量 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | 主模型 API key |
| `OPENAI_BASE_URL` | OpenAI-compatible 地址 |
| `OPENAI_MODEL` | 主模型 |
| `SUMMARY_MODEL` | 摘要模型 |
| `Q_CODE_HOME` | 全局配置和运行数据目录 |
| `Q_CODE_SESSION_DIR` | 会话目录 |
| `Q_CODE_AUDIT_ENABLED` | 审计日志开关 |
| `Q_CODE_LANGFUSE_ENABLED` | Langfuse 导出开关 |

完整列表仍以 README 和 `.env.example` 为准。

## 安全提醒

- 不要提交 `.env`、`.q-code/`、`.sessions/`。
- 文档、issue 和日志里不要出现 API key、token、服务器密码。
- Langfuse 默认不上传 prompt、工具结果和文件内容原文，只有显式开启 `Q_CODE_LANGFUSE_RECORD_IO` 才会记录。
