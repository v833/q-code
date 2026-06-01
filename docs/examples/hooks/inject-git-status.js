#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (event.event !== 'user_prompt_submit') return;

  const cwd = event.cwd || process.cwd();
  const branch = safeGit(['branch', '--show-current'], cwd) || 'unknown';
  const status = safeGit(['status', '--short'], cwd);
  const summary = status ? status.split('\n').slice(0, 20).join('\n') : 'clean';

  process.stdout.write(JSON.stringify({
    action: 'modify',
    appendContext: `Git branch: ${branch}\nGit status:\n${summary}`
  }));
});

function safeGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
