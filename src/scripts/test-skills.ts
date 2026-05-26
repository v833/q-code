/**
 * Legacy 冒烟脚本：Skills 目录加载、预算、条件激活与斜杠展开。
 * 由 `pnpm test:skills` 调用。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'q-code-skills-'))
const cwd = join(root, 'project')
const home = join(root, 'home')
process.env.Q_CODE_HOME = home

mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })

function writeSkill(base: string, name: string, content: string): void {
  const dir = join(base, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`断言失败: ${message}`)
  console.log(`✓ ${message}`)
}

try {
  writeSkill(
    join(home),
    'hello-world',
    [
      '---',
      'name: hello-world',
      'description: Global hello skill.',
      '---',
      '',
      'This global body should be overridden.'
    ].join('\n')
  )

  writeSkill(
    join(cwd, '.q-code'),
    'hello-world',
    [
      '---',
      'name: hello-world',
      'description: Greet the user and prove Skills are wired.',
      'when_to_use: When the user asks for a hello world demo.',
      'allowed-tools: [read_file]',
      'argument-hint: "[optional name]"',
      '---',
      '',
      'Hello $ARGUMENTS from ${Q_CODE_SKILL_DIR} in ${Q_CODE_SESSION_ID}.'
    ].join('\n')
  )

  writeSkill(
    join(cwd, '.q-code'),
    'test-reviewer',
    [
      '---',
      'name: test-reviewer',
      'description: Audit tests for brittle assertions.',
      'paths:',
      '  - "**/*.test.ts"',
      '  - "tests/**"',
      '---',
      '',
      'Review the test file.'
    ].join('\n')
  )

  writeSkill(
    join(cwd, '.q-code'),
    'secret-handshake',
    [
      '---',
      'name: secret-handshake',
      'description: Hidden user-only skill.',
      'disable-model-invocation: true',
      '---',
      '',
      'This should not be model-visible.'
    ].join('\n')
  )

  const [{ bootstrapSkills }, registry, budget, conditional, invocation, { createSkillTool }] =
    await Promise.all([
      import('../skills/bootstrap'),
      import('../skills/registry'),
      import('../skills/budget'),
      import('../skills/conditional'),
      import('../skills/invocation'),
      import('../tools/skill-tools')
    ])

  console.log('\n[1] 启动加载')
  const result = await bootstrapSkills(cwd)
  assert(result.skillCount === 1, '加载 1 个模型可见的 Skill')
  assert(result.conditionalCount === 1, '加载 1 个条件激活 Skill')
  assert(result.warnings.length === 0, '合法 fixture 下不产生告警')

  const all = registry.getAllUserInvocableSkills()
  const visible = registry.getModelVisibleSkills()
  assert(all.length === 3, '用户可触发的 Skill 列表包含隐藏与条件激活的项')
  assert(
    visible.some((skill) => skill.name === 'hello-world'),
    'hello-world 对模型可见'
  )
  assert(!visible.some((skill) => skill.name === 'test-reviewer'), '条件激活 Skill 默认隐藏')
  assert(
    !visible.some((skill) => skill.name === 'secret-handshake'),
    'disable-model-invocation 的 Skill 对模型隐藏'
  )
  assert(
    registry.findSkill('hello-world')?.source === 'project',
    '项目级 Skill 覆盖用户级同名 Skill'
  )

  console.log('\n[2] 渐进式披露 system-reminder')
  const reminder = budget.formatSkillsSystemReminder(visible)
  assert(reminder.includes('<system-reminder>'), '渲染出 <system-reminder> 包裹')
  assert(reminder.includes('- hello-world:'), '列出可见 Skill 的名称与描述')
  assert(!reminder.includes('Hello $ARGUMENTS'), 'discovery 阶段不披露 SKILL.md 正文')
  assert(!reminder.includes('test-reviewer'), '条件 Skill 未激活前不出现在列表中')

  console.log('\n[3] 路径命中条件激活')
  const activated = conditional.activateConditionalSkillsForPaths(['src/foo.test.ts'], cwd)
  assert(activated.includes('test-reviewer'), '路径匹配的条件 Skill 被激活')
  assert(
    registry.getModelVisibleSkills().some((skill) => skill.name === 'test-reviewer'),
    '激活后该 Skill 对模型可见'
  )

  console.log('\n[4] Skill 工具执行')
  const skillTool = createSkillTool({ getSessionId: () => 'session-123' })
  const toolResult = await skillTool.execute({ skill: 'hello-world', args: 'Ada' }, { cwd })
  assert(typeof toolResult === 'string', 'Skill 工具返回文本')
  assert(
    String(toolResult).includes('Follow the instructions below'),
    'Skill 工具以“按下面指引执行”包裹正文'
  )
  assert(String(toolResult).includes('Hello Ada'), 'Skill 工具替换 $ARGUMENTS')
  assert(String(toolResult).includes('session-123'), 'Skill 工具替换 session id')
  assert(!String(toolResult).includes('Global hello'), 'Skill 工具使用项目级覆盖后的正文')

  const hiddenResult = await skillTool.execute({ skill: 'secret-handshake' }, { cwd })
  assert(
    String(hiddenResult).includes('disable-model-invocation'),
    'Skill 工具拒绝对隐藏 Skill 的模型调用'
  )

  console.log('\n[5] 斜杠命令展开')
  const expansion = invocation.expandSkillSlashCommand('/hello-world Grace', 'session-456')
  assert(
    expansion?.markerContent.includes('<command-name>/hello-world</command-name>'),
    '斜杠命令输出 marker 块'
  )
  assert(
    expansion?.bodyText.startsWith('[skill_invocation:hello-world]'),
    '斜杠命令输出内部 sentinel 标记'
  )
  assert(expansion?.bodyText.includes('Hello Grace'), '斜杠命令替换参数')

  console.log('\n所有 Skills 检查均通过。\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
