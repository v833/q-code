# 快速开始

这页给第一次接触 q-code 的维护者和使用者。只保留能跑起来的路径。

## 先装环境

- Node.js 22 或更高版本。
- pnpm。仓库开发不要混用 npm 或 yarn 生成新 lockfile。

## 从源码运行

```bash
pnpm install
pnpm start
```

恢复上次会话：

```bash
pnpm continue
```

## 全局安装使用

```bash
npm install -g @q-code-cli/q-code
q-code
```

首次配置推荐用向导：

```bash
q-code init
```

## 日常检查

```bash
pnpm typecheck
pnpm test:unit
pnpm precommit
```

改动涉及 Agent Loop、工具、会话、MCP、Hooks、SubAgent 或 TUI 时，按 [测试](../development/testing.md) 选择更具体的测试。

## 下一步

- 想配置模型和路径：看 [配置](./configuration.md)。
- 想理解界面和命令：看 [命令行与 TUI](./cli-and-tui.md)。
- 想改代码：从 [仓库地图](../development/repository-map.md) 开始。
