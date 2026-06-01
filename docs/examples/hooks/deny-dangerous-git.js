#!/usr/bin/env node
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const command = String(event.tool?.input?.command ?? '');
  const dangerous = [
    /\bgit\s+push\b.*\s--force(?:-with-lease)?\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-fd/,
    /\bgit\s+push\s+origin\s+main\b/
  ];
  if (event.event === 'pre_tool_use' && dangerous.some((pattern) => pattern.test(command))) {
    console.error('Hook 阻止了危险 Git 操作');
    process.exit(2);
  }
});
