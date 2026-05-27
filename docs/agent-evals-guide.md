# Agent 评测与回归框架指南

本文面向 q-code 维护者和后续功能实现者，解释 `q-code eval` 这套 Agent 评测与回归框架的目标、运行方式、文件结构、case 写法、报告解读和扩展方法。

如果只想快速验证当前分支，先看“快速开始”。如果要新增 case 或改 eval 框架，建议完整读一遍。

## 这套框架解决什么问题

普通单元测试擅长验证函数和模块，但 Agent 行为还会受到 prompt、工具描述、模型、上下文、预算、文件副作用和安全策略影响。`q-code eval` 用固定任务集把这些行为变成可重复评估的 artifact：

- 是否完成任务：最终回答、文件改动、退出码、测试结果。
- 过程是否合理：工具调用路径、额外工具、步骤数、progress timeline。
- 成本是否可控：tokens、duration、tool calls、estimated cost。
- 安全是否合规：泄密、禁止路径、禁止输出、工具输入输出策略。
- 是否回归：baseline compare、trend、JUnit、nightly regression。
- 是否可观测：本地 JSON/Markdown/JUnit/JSONL trace，外加可选 Langfuse trace/dataset/scores。

核心原则：**本地 `.q-code/evals` artifact 是真源，Langfuse 只是可选外部后端**。即使 Langfuse 不可用，本地 eval 也必须能跑、能评分、能复现。

## 快速开始

常用命令：

```powershell
pnpm eval:smoke
pnpm eval:cli
pnpm eval:ci
pnpm eval:trend
```

手动运行指定 suite：

```powershell
q-code eval list evals/smoke
q-code eval run evals/smoke --no-langfuse
q-code eval run evals/cli --no-langfuse
q-code eval run evals/smoke evals/cli --report json,md,junit --max-cost-usd 0.05
```

建立 baseline 并对比候选 run：

```powershell
q-code eval promote .q-code/evals/runs/<run-id> --as main
q-code eval compare main .q-code/evals/runs/<candidate-run-id>
```

运行真实模型和 LLM judge 必须显式 opt-in：

```powershell
q-code eval run evals/live --allow-real-model --judge --max-cost-usd 0.05
```

导出到 Langfuse：

```powershell
q-code eval run evals/smoke --langfuse
q-code eval run evals/smoke --langfuse --langfuse-datasets
```

## 核心概念

| 概念 | 含义 | 主要位置 |
| --- | --- | --- |
| suite | 一组 eval case，通常对应一个目录或 YAML 文件 | `evals/smoke/basic.yaml` |
| case | 一个固定任务，包含输入、执行模式、mock/cli/real 配置和期望 | `EvalCase` |
| mode | 执行模式：`mock-agent`、`cli-subprocess`、`real-agent` | `src/evals/types.ts` |
| runner | 运行 case，生成执行结果和 trace | `src/evals/runner.ts` |
| trace | 每个 case 的模型文本、工具调用、工具结果、usage、错误等 JSONL 事件 | `src/evals/trace-recorder.ts` |
| scorer | 根据 final、trajectory、budget、safety、side effect 等期望评分 | `src/evals/scorers.ts` |
| judge | 可选 LLM-as-judge，用 rubric 给语义质量打分 | `src/evals/judge.ts` |
| artifact | 每次 run 的本地结果目录 | `.q-code/evals/runs/<run-id>/` |
| baseline | 命名基线，用于和候选 run 对比 | `.q-code/evals/baselines/<name>/` |
| trend | 从历史 run 聚合出的趋势看板 | `.q-code/evals/trends/` |
| Langfuse export | 可选外部 trace、dataset run item 和 scores 同步 | `src/evals/langfuse-export.ts`、`src/evals/langfuse-api.ts` |

## 目录和模块

```text
src/evals/
├── cli.ts               # q-code eval 子命令解析
├── compare.ts           # baseline promote 和 compare
├── index.ts             # eval 模块导出
├── judge.ts             # opt-in LLM-as-judge scorer
├── langfuse-api.ts      # Langfuse dataset run items / scores Public API bridge
├── langfuse-export.ts   # eval run -> Langfuse evaluator trace
├── loader.ts            # 读取 evals/**/*.yaml|json
├── mock-model.ts        # mock-agent 模型
├── mock-tools.ts        # mock-agent 工具
├── model.ts             # real-agent / judge 模型工厂
├── report.ts            # JSON/Markdown/JUnit 报告渲染
├── runner.ts            # mock/cli/real runner 和 artifact 写出
├── scorers.ts           # deterministic scorer
├── trace-recorder.ts    # trace event 收集
├── trend.ts             # 历史 run 趋势看板
└── types.ts             # eval 类型定义
```

示例和 fixture：

```text
evals/
├── smoke/basic.yaml              # deterministic mock-agent smoke cases
├── cli/basic.yaml                # cli-subprocess side-effect case
├── live/basic.yaml               # real-agent + judge opt-in 示例
└── fixtures/cli-basic/           # cli-subprocess 隔离 fixture
```

测试：

```text
tests/unit/evals.test.ts
tests/unit/cli-info.test.ts
```

## 三种执行模式

### mock-agent

`mock-agent` 不调用真实模型，也不依赖真实工具。case 用 `mock.turns` 脚本化模型输出和工具调用，适合 CI、smoke、trajectory、budget、安全策略测试。

适合：

- 最终回答格式和关键词。
- 工具轨迹 strict/unordered/subset。
- forbidden/required tools。
- cost/token/step budget。
- safety/policy scorer。
- LLM judge 配置是否被正确 opt-in。

不适合：

- 验证真实模型是否会选对工具。
- 验证真实工具实现。
- 验证复杂文件副作用。

### cli-subprocess

`cli-subprocess` 会复制 `setup.fixture` 到 run 目录下的隔离 workspace，然后执行 `cli.command + cli.args`。它用 stdout/stderr、退出码和文件副作用评分。

适合：

- 验证真实命令或脚本行为。
- 验证文件被正确修改。
- 验证 fixture 中测试命令是否通过。
- 验证 stdout/stderr、退出码和 artifact。

注意：

- fixture 必须小而稳定。
- 文件断言限制在隔离 workspace 内。
- 不要依赖开发机上的临时状态。

### real-agent

`real-agent` 复用真实 `agentLoop + ToolRegistry + OPENAI_*` 模型配置。它最接近真实 Agent 行为，但有成本、波动和外部依赖，所以必须显式传 `--allow-real-model`。

适合：

- 手动验证真实模型能力。
- live benchmark。
- 配合 `--judge` 做语义质量评分。
- 配合 Langfuse 看真实 trace。

安全默认值：

- 默认只暴露只读工具。
- 写文件或 shell 工具必须在 case 的 `real.tools` 中显式列出。
- LLM judge 必须传 `--judge` 才运行。

## Case 文件结构

最小结构：

```yaml
suite: smoke
name: Deterministic agent smoke evals
cases:
  - id: final-answer-contains
    name: 单步最终回答包含目标文本
    tags: [final, regression]
    difficulty: easy
    mode: mock-agent
    prompt: "总结 q-code 的 TUI 能力"
    mock:
      turns:
        - text: "TUI 会展示工具进度、上下文占用和最终回答。"
          finishReason: stop
          usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 }
    expect:
      final:
        contains: ["TUI", "工具进度"]
      budgets:
        maxSteps: 2
        maxToolCalls: 0
        maxTotalTokens: 40
        maxCostUsd: 0.0001
      safety:
        forbidSecrets: true
```

建议每个 case 都写：

- `id`：稳定、可 grep、不要频繁改名。
- `name`：给报告看的中文标题。
- `tags`：用于过滤和后续 breakdown。
- `difficulty`：`easy | medium | hard`。
- `mode`：三种执行模式之一。
- `prompt`：任务输入。
- `expect`：至少包含一个可评分断言。
- `budgets`：至少限制 steps、tool calls 或 duration。
- `safety`：涉及 prompt、工具、文件、输出时建议加。

## Scorer 和指标

`scoreEvalCase` 会把多个 check 聚合成 `score` 和 `success`。

| 断言 | 用途 | 典型错误类型 |
| --- | --- | --- |
| `final.contains` / `final.regex` | 最终回答是否符合预期 | `final_answer_mismatch` |
| `trajectory.requiredTools` | 必须调用某些工具 | `wrong_tool` |
| `trajectory.forbiddenTools` | 禁止调用某些工具 | `wrong_tool` |
| `trajectory.mode` | 工具顺序 strict/unordered/subset | `wrong_tool` |
| `trajectory.maxExtraTools` | 限制额外工具 | `wrong_tool` |
| `trajectory.expectedSteps` | 指定某一步应调用的工具 | `wrong_tool` |
| `budgets.maxSteps` | 步数预算 | `step_budget_exceeded` |
| `budgets.maxToolCalls` | 工具调用预算 | `step_budget_exceeded` |
| `budgets.maxDurationMs` | 耗时预算 | `timeout` |
| `budgets.maxTotalTokens` | token 预算 | `cost_budget_exceeded` |
| `budgets.maxCostUsd` | 成本预算 | `cost_budget_exceeded` |
| `safety.forbidSecrets` | 防止输出疑似密钥 | `policy_violation` |
| `safety.forbidden*Patterns` | 禁止输出或工具输入/输出匹配模式 | `policy_violation` |
| `safety.forbiddenPaths` | 禁止访问路径 | `policy_violation` |
| `sideEffects.files` | 文件存在和内容断言 | `wrong_file_side_effect` |
| `sideEffects.gitDiff` | workspace diff 状态 | `wrong_file_side_effect` |
| `judge.rubric` | LLM-as-judge 语义评分 | `final_answer_mismatch` 或 judge check fail |

关键指标：

- `success`：所有 check 是否通过。
- `score`：deterministic/judge check 通过率。
- `progressRate`：checkpoint 进度，没有 checkpoint 时回退到 `score`。
- `progressTimeline`：进度在哪些 step 提升。
- `errorType`：第一个失败 check 的归因。
- `toolMetrics`：工具总调用、成功/失败、平均耗时、分布。
- `usage` / `estimatedCostUsd`：token 和估算成本。
- `judgeScore` / `judgeReason`：LLM judge 输出。

## Run artifact 怎么看

每次 run 默认写到：

```text
.q-code/evals/runs/<run-id>/
├── run.json
├── cases.jsonl
├── report.md
├── junit.xml              # 仅 --report 包含 junit 时生成
├── traces/*.jsonl
├── failures/
└── workspaces/            # cli-subprocess / real-agent fixture workspace
```

优先阅读顺序：

1. `report.md`：人读摘要，包含总览、case 表格、失败详情、difficulty breakdown、repro 命令。
2. `cases.jsonl`：逐 case 结果，适合脚本分析。
3. `run.json`：run 级 summary、filters、limits、Langfuse 导出状态。
4. `traces/*.jsonl`：定位工具轨迹、usage、错误。
5. `failures/` 和 `workspaces/`：查看 stdout/stderr、文件副作用和隔离 workspace。

失败时先看 `report.md` 中的 repro 命令，再看对应 trace。通常定位顺序是：

```text
errorType -> failed checks -> trace -> workspace diff/stdout/stderr
```

## Baseline、Compare 和 Trend

保存一次 run 为命名 baseline：

```powershell
q-code eval promote .q-code/evals/runs/<run-id> --as main
```

比较 baseline 和候选：

```powershell
q-code eval compare main .q-code/evals/runs/<candidate-run-id>
```

当前 compare 会输出：

- pass rate 变化。
- average score delta。
- progress delta。
- token delta。
- cost delta。
- 新增失败和修复失败。

生成趋势：

```powershell
q-code eval trend --limit 30
```

输出：

```text
.q-code/evals/trends/trend.json
.q-code/evals/trends/trend.md
```

趋势适合回答“最近几次 run 是否更贵、更慢、progress 变差、通过率下降”。

## Langfuse 的角色

Langfuse 是可选 exporter，不是 eval 真源。

开启方式依赖 `.env` 或 `.q-code/config.toml`：

```env
Q_CODE_LANGFUSE_ENABLED=true
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
LANGFUSE_BASE_URL=http://...
Q_CODE_LANGFUSE_RECORD_IO=false
```

默认 `record_io=false`，不会上传完整 prompt、文件内容、shell 输出或工具结果，只上传摘要、hash、长度、工具名、耗时、token、错误和分数。

两类导出：

- `--langfuse`：把 eval run 导出为 evaluator trace/observation。
- `--langfuse-datasets`：额外写 Langfuse dataset item、dataset run item 和 scores。

导出的 score 名包括：

- `q-code.success`
- `q-code.score`
- `q-code.progress_rate`
- `q-code.tool_execution_validity`
- `q-code.duration_ms`
- `q-code.estimated_cost_usd`
- `q-code.judge_score`

导出失败默认不让本地 eval 失败。需要把 Langfuse 导出作为硬性检查时，才使用 `--strict-langfuse`。

## CI 和定期回归

package scripts：

```json
{
  "eval:smoke": "tsx src/index.ts eval run evals/smoke --no-langfuse",
  "eval:cli": "tsx src/index.ts eval run evals/cli --no-langfuse",
  "eval:ci": "tsx src/index.ts eval run evals/smoke evals/cli --no-langfuse --report json,md,junit",
  "eval:smoke:langfuse": "tsx src/index.ts eval run evals/smoke --langfuse",
  "eval:nightly": "tsx src/index.ts eval run evals/smoke evals/cli --langfuse --langfuse-datasets --report json,md,junit --max-cost-usd 0.05 && tsx src/index.ts eval trend --limit 30",
  "eval:trend": "tsx src/index.ts eval trend",
  "eval:compare": "tsx src/index.ts eval compare"
}
```

默认 CI 建议只跑 deterministic、低成本、不依赖真实模型的 suite：

```powershell
pnpm eval:ci
```

nightly 可以开启 Langfuse，但仍以本地 deterministic smoke/cli 为主。真实模型 eval 应该保持手动或受成本上限保护。

## 新增 Eval Case 的 checklist

新增 case 前先判断它属于哪类：

- 只验证 Agent 决策和 scorer：用 `mock-agent`。
- 验证命令输出或文件副作用：用 `cli-subprocess`。
- 验证真实模型行为：用 `real-agent`，并保持 opt-in。

新增 case checklist：

- [ ] `id` 稳定，能被 `--grep ^id$` 精确复跑。
- [ ] 有 `tags`，后续能用于过滤和归因。
- [ ] 有 `difficulty`。
- [ ] 有明确 `expect`，不是只靠人工读报告。
- [ ] 有预算，避免 flaky 或长时间卡住。
- [ ] 涉及文件副作用时使用 fixture 和隔离 workspace。
- [ ] 涉及真实模型时设置 `maxCostUsd`、`timeoutMs` 和只读工具。
- [ ] 涉及语义质量时使用 opt-in `judge`，不要让默认 CI 依赖 judge。
- [ ] 涉及敏感信息时加 safety 断言。
- [ ] README/AGENTS/测试脚本按需同步。

新增后至少跑：

```powershell
pnpm exec vitest run tests/unit/evals.test.ts tests/unit/cli-info.test.ts
pnpm eval:ci
```

如果改了类型、CLI、runner 或 scorer，继续跑：

```powershell
pnpm typecheck
```

## 排障速查

### `real-agent eval 需要显式传入 --allow-real-model`

这是安全设计。真实模型 eval 必须手动 opt-in：

```powershell
q-code eval run evals/live --allow-real-model
```

### judge 没有运行

同时满足两个条件才会跑：

- case 中有 `expect.judge`。
- CLI 传了 `--judge`。

judge 模型优先读取 `Q_CODE_EVAL_JUDGE_*`，未设置时回退 `SUMMARY_*`。

### 成本显示 unknown

真实模型如果没有在 `src/usage/pricing.ts` 里配置价格，会保留 token 指标，但成本为 unknown。需要补价格表或只用 token/duration 作为预算。

### Langfuse 没有数据

检查：

- `Q_CODE_LANGFUSE_ENABLED=true`
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`
- 是否用了 `--no-langfuse`
- 是否需要 `--langfuse-datasets`

本地 eval 成功但 Langfuse 失败时，优先看 `run.json.summary.langfuseMessage`。

### Case 通过了但 `progressRate` 不是 1

通常是 `expect.checkpoints` 没有全部出现在 `assistant_text` 或 `final_state` 中。要么修正 checkpoint，要么不要给这个 case 配 checkpoint。

### `cli-subprocess` 文件断言失败

先看 run 目录下的：

```text
failures/<case-id>-<repeat>/stdout.txt
failures/<case-id>-<repeat>/stderr.txt
workspaces/<case-id>-<repeat>-*/ 
```

确认脚本是否在隔离 workspace 中改了预期文件。

## 当前边界和后续方向

当前框架已经覆盖 #31 的核心目标，但还不是完整 Agent 质量平台。后续由 #32 追踪：

- 自动优化建议报告。
- trace-to-case 回流。
- 更细 compare breakdown。
- quality gate。
- 真实 coding benchmark。
- 完整 trace replay。
- 失败样例自动最小化。
- 稳定 live benchmark 集。

在这些能力完成前，当前 eval 最适合作为“本地优先的 Agent 回归框架”和“Langfuse 可选观测桥”，不是自动优化系统。

