import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONTRACT_VERSION } from '../src/contract/spec.ts'
import { checkWorkerImage } from '../src/executor/worker-image.ts'
import { ROOT } from '../src/runtime/paths.ts'
import type { Command } from '../src/runtime/types.ts'

test.each(['worker/Dockerfile', 'deploy/docker/Dockerfile'])(
  '%s 声明的默认契约版本与 CONTRACT_VERSION 一致',
  async (file) => {
    const dockerfile = await readFile(join(ROOT, file), 'utf8')
    expect(dockerfile).toMatch(/^LABEL\s.*io\.workling\.contract=\$WORKER_CONTRACT/m)
    expect(/^ARG WORKER_CONTRACT=(\d+)$/m.exec(dockerfile)?.[1]).toBe(String(CONTRACT_VERSION))
  },
)

test('worker 镜像只复制 worker/ 与 src/contract/', async () => {
  const dockerfile = await readFile(join(ROOT, 'worker/Dockerfile'), 'utf8')
  const copies = [...dockerfile.matchAll(/^COPY (?!--from)(.+)$/gm)].map((match) => match[1])
  expect(copies).toEqual([
    'package.json bun.lock bunfig.toml tsconfig.json ./',
    'src/contract/ ./src/contract/',
    'worker/ ./worker/',
  ])
})

function inspect(output: string | Error): { command: Command; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    command: async (args) => {
      calls.push(args)
      if (output instanceof Error) throw output
      return output
    },
  }
}

test('契约标签一致时兼容', async () => {
  const { command, calls } = inspect(
    JSON.stringify({ 'io.workling.contract': String(CONTRACT_VERSION) }),
  )
  expect(await checkWorkerImage(command, 'w:1')).toBeNull()
  expect(calls[0]).toEqual([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{json .Config.Labels}}',
    'w:1',
  ])
})

test.each([
  [new Error('No such image'), '找不到 worker 镜像 w:1'],
  ['null', '没有声明契约版本'],
  ['{"other":"1"}', '没有声明契约版本'],
  ['not json', '无法读取 worker 镜像 w:1 的标签'],
  [
    JSON.stringify({ 'io.workling.contract': '999' }),
    `契约版本为 999，主体需要 ${CONTRACT_VERSION}`,
  ],
] as const)('镜像不兼容时给出原因 %#', async (output, message) => {
  expect(await checkWorkerImage(inspect(output).command, 'w:1')).toContain(message)
})

test.each(['worker/Dockerfile', 'deploy/docker/Dockerfile'])(
  '%s 的构建上下文排除依赖、运行数据、Git 与环境文件',
  async (file) => {
    const ignore = (await readFile(join(ROOT, `${file}.dockerignore`), 'utf8')).split('\n')
    for (const entry of ['node_modules', '.runtime', '.git', '.env*'])
      expect(ignore).toContain(entry)
  },
)
