import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT } from '../src/runtime/paths.ts'

test('Docker image installs common agent tools and provides the fd command', async () => {
  const dockerfile = await readFile(join(ROOT, 'deploy/docker/Dockerfile'), 'utf8')
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
