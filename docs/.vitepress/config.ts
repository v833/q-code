import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'q-code',
  description: 'q-code 内部说明文档',
  cleanUrls: true,
  ignoreDeadLinks: true,
  head: [['link', { rel: 'icon', type: 'image/png', href: '/q-code-duck-64.png' }]],
  themeConfig: {
    logo: '/q-code-duck-64.png',
    siteTitle: 'q-code',
    search: {
      provider: 'local'
    },
    nav: [
      { text: '指南', link: '/guide/getting-started' },
      { text: '架构', link: '/architecture/overview' },
      { text: '开发', link: '/development/repository-map' },
      { text: '参考', link: '/reference/commands' }
    ],
    sidebar: [
      {
        text: '指南',
        items: [
          { text: '快速开始', link: '/guide/getting-started' },
          { text: '配置', link: '/guide/configuration' },
          { text: '命令行与 TUI', link: '/guide/cli-and-tui' }
        ]
      },
      {
        text: '架构',
        items: [
          { text: '整体视图', link: '/architecture/overview' },
          { text: 'Agent Loop', link: '/architecture/agent-loop' },
          { text: '上下文与 Prompt', link: '/architecture/context-and-prompt' },
          { text: '工具与 MCP', link: '/architecture/tools-and-mcp' },
          { text: 'SubAgent 与 Teams', link: '/architecture/subagents-and-teams' },
          { text: '会话与可观测性', link: '/architecture/sessions-and-observability' }
        ]
      },
      {
        text: '开发',
        items: [
          { text: '仓库地图', link: '/development/repository-map' },
          { text: '测试', link: '/development/testing' },
          { text: '文档规则', link: '/development/documentation-rules' },
          { text: 'Eval 指南', link: '/agent-evals-guide' }
        ]
      },
      {
        text: '参考',
        items: [
          { text: '命令速查', link: '/reference/commands' },
          { text: '目录速查', link: '/reference/file-layout' },
          { text: '安全边界', link: '/reference/safety' }
        ]
      }
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/v833/q-code' }],
    footer: {
      message: 'Built for q-code maintainers.',
      copyright: 'MIT Licensed'
    }
  }
})
