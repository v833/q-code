# Agent Prompt 质量基线

q-code 的 system prompt 已经拆成稳定 system prompt 与动态 transient context。稳定前缀负责长期不变的行为纪律，动态上下文负责本轮工具、Skills、任务、记忆和运行环境。Prompt 质量基线的目标不是把更多内容塞进 system prompt，而是把关键行为维度变成可审计、可回归的清单。

本地检查命令：

```powershell
pnpm prompt:quality:verify
pnpm prompt:quality:verify -- --format=md
```

该命令只读当前 prompt pipe 与项目指令，不调用模型，不上传数据。它会输出 12 个维度的 `pass`、`warn` 或 `missing`：

- `pass`：必需证据和推荐证据都存在。
- `warn`：已有必需证据，但仍缺少推荐证据。
- `missing`：没有找到该维度的必需证据，需要补齐。

## 12 个维度

| 维度 | q-code 映射 | 质量要求 |
| --- | --- | --- |
| 身份与运行形态 | `coreRules` | 明确 q-code 是有工具调用能力的代码 Agent，而不是通用聊天助手。 |
| 安全边界 | `coreRules`、`AGENTS.md` 运行纪律、工具权限、Hooks、审计 | 明确敏感信息、权限、危险操作和拒绝边界。 |
| 工具调用契约 | `toolDiscipline`、工具 schema | 说明读取、搜索、委派、并行/串行和失败换路规则。 |
| 工作流阶段门 | Plan Mode、Task、Todo | 复杂任务先理解和规划，执行后验证，不把未完成项标为完成。 |
| 输出格式与界面契约 | TUI、最终回答格式 | 进度更新短小公开，最终答复简洁，适配终端渲染。 |
| 最小编辑与验证闭环 | 文件工具、`apply_patch`、测试策略 | 先读后改，最小变更，验证失败不得宣称完成。 |
| 项目记忆边界 | `memory/`、transient memory context | 索引常驻、正文按需、写入保守，支持忽略记忆。 |
| 沟通分级 | 中间进度、澄清问题 | 能自查则自查，只有缺关键信息或高影响决策才问用户。 |
| q-code 领域知识 | 共享稳定 pipe、Skills、SubAgent、Hooks、Eval、Output Styles | 把项目本体概念映射清楚，避免泛化提示词误用。 |
| 正反例对齐 | compact examples | 对工具选择、失败恢复、沟通分级等易错点提供少量例子。 |
| 失败恢复阶梯 | retry、错误提示、工具纪律 | 核实参数、按报错修复、换路，最后再求助用户。 |
| 品质量化约束 | 前端/文档/用户可见输出规则 | 把“高质量”拆成可执行约束，不靠主观形容词。 |

## 使用方式

开发 prompt 或工具纪律时，先运行：

```powershell
pnpm prompt:quality:verify -- --format=md
```

如果出现 `missing`，说明某个维度在当前稳定 prompt 或项目指令中没有基础证据，应先补齐规则或文档。`warn` 不阻塞开发，但应在 PR 中说明是否故意保留缺口。

Prompt cache 和 prompt quality 是两条不同的验证线：

- `pnpm prompt:cache:verify` 验证稳定前缀 hash 和 cache 命中目标。
- `pnpm prompt:quality:verify` 验证 Agent 行为维度是否有可审计证据。

新增规则时优先复用已有 pipe。动态、查询相关或本轮才有效的信息应继续放入 transient context，避免破坏稳定 system prompt 前缀。

AGENT.md / AGENTS.md 是项目规则权威来源，但超长文件不会整篇常驻 system prompt。q-code 会保留模型运行纪律摘要和章节索引；需要人类文档细节时再按 Source 路径读取全文。
