# 命令速查

## 开发

```bash
pnpm install
pnpm start
pnpm continue
pnpm typecheck
pnpm test:unit
pnpm precommit
```

## 文档站

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

## q-code CLI

```bash
q-code
q-code --continue
q-code --session <id>
q-code --plan
q-code --agent-teams
q-code init
q-code update
q-code dashboard
q-code dashboard --port 0 --open
q-code dashboard --host localhost
q-code audit verify
q-code audit tail
q-code eval run evals/smoke --no-langfuse
```

## 交互内置 Slash

```bash
/output-style
/output-style Explanatory
/output-style default
/commands
/commands doctor
/hooks
/skills
/sessions
/model
/usage
```

## 测试

```bash
pnpm test
pnpm test:integration
pnpm test:legacy
pnpm test:agents
pnpm test:teams
pnpm eval:smoke
pnpm eval:cli
```
