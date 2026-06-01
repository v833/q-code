#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (event.event !== 'stop') return;
  const cwd = event.cwd || process.cwd();
  const changed = safeGit(['status', '--short'], cwd);
  if (!changed) return;
  console.error('本轮存在未提交改动，请运行 pnpm typecheck 和相关测试后再结束。');
  process.exit(2);
});

function safeGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
