/**
 * Legacy 冒烟脚本：企业 Infra 知识候选上报（需配置 base URL / token）。
 * 由 `pnpm test:infra-candidate` 调用。
 */
import { bootstrapMcp, closeMcpSubsystem } from '../mcp/bootstrap'
import { submitInfraKnowledgeCandidate } from '../infra/candidate'
import { ToolRegistry } from '../tools/registry'

const cwd = process.cwd()
const registry = new ToolRegistry({ cwd, quiet: true })

try {
  const boot = await bootstrapMcp(cwd, registry)
  console.log(
    JSON.stringify(
      {
        connections: boot.connections.map((connection) => ({
          name: connection.name,
          type: connection.type
        })),
        toolCount: boot.toolCount
      },
      null,
      2
    )
  )

  const result = await submitInfraKnowledgeCandidate({
    cwd,
    registry,
    args: [
      '--type faq',
      '--title "q-code 联调候选知识"',
      '--domain domain_demo',
      'q-code 可以通过 /infra candidate 调用 enterprise_kb 的 submit_knowledge_candidate，把候选知识写入独立 knowledge-mcp-server。'
    ].join(' ')
  })

  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
} finally {
  await closeMcpSubsystem()
}
