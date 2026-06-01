#!/usr/bin/env node
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (event.event !== 'post_tool_use') return;
  const tool = event.tool?.name || '';
  if (!/write_file|edit_file|apply_patch/.test(tool)) return;
  process.stdout.write(JSON.stringify({
    action: 'warn',
    message: '检测到文件修改，请按项目约定运行格式化或相关测试。'
  }));
});
