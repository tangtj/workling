import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT } from '../src/runtime/paths.ts'

test('worker image installs common agent tools and provides the fd command', async () => {
  const dockerfile = await readFile(join(ROOT, 'worker/Dockerfile'), 'utf8')
  const installs = [...dockerfile.replace(/\\\n/g, ' ').matchAll(/apt-get install\s+[^&\n]*/g)]
    .map((match) => match[0])
    .join(' ')
  for (const name of [
    'ripgrep',
    'fd-find',
    'jq',
    'less',
    'file',
    'tree',
    'patch',
    'unzip',
    'xz-utils',
    'procps',
    'lsof',
    'make',
    'python3',
    'sqlite3',
  ]) {
    expect(installs.split(/\s+/)).toContain(name)
  }
  expect(dockerfile).toMatch(/ln\s+-s\s+\/usr\/bin\/fdfind\s+\/usr\/local\/bin\/fd(?:\s|$)/)
})

test('主体镜像只装调度所需命令，不含 Pi、codex 与 worker 代码', async () => {
  const dockerfile = await readFile(join(ROOT, 'deploy/docker/Dockerfile'), 'utf8')
  expect(dockerfile).toContain('docker-ce-cli')
  expect(dockerfile).toMatch(/install[^\n]*\bgh\b/)
  for (const forbidden of ['@openai/codex', 'ripgrep', 'COPY worker/', 'WORKLING_CODEX_SANDBOX'])
    expect(dockerfile).not.toContain(forbidden)
})
