import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONTRACT_VERSION } from '../src/contract/spec.ts'
import { checkWorkerImage, ensureWorkerImage } from '../src/executor/worker-image.ts'
import { ROOT } from '../src/runtime/paths.ts'
import type { Command } from '../src/runtime/types.ts'

test.each(['worker/Dockerfile'])('%s 声明的默认契约版本与 CONTRACT_VERSION 一致', async (file) => {
  const dockerfile = await readFile(join(ROOT, file), 'utf8')
  expect(dockerfile).toMatch(/^LABEL\s.*io\.workling\.contract=\$WORKER_CONTRACT/m)
  expect(/^ARG WORKER_CONTRACT=(\d+)$/m.exec(dockerfile)?.[1]).toBe(String(CONTRACT_VERSION))
})

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

test('本机没有镜像时只拉取一次，拉取后按标签判断兼容', async () => {
  const calls: string[][] = []
  let pulled = false
  const command: Command = async (args) => {
    calls.push(args)
    if (args[1] === 'pull') {
      pulled = true
      return ''
    }
    if (!pulled) throw new Error('No such image')
    return JSON.stringify({ 'io.workling.contract': String(CONTRACT_VERSION) })
  }
  const attempted = new Set<string>()
  const logs: string[] = []
  expect(
    await ensureWorkerImage(command, 'ghcr.io/a/b-worker:v1', attempted, (m) => logs.push(m)),
  ).toBeNull()
  expect(calls.filter((args) => args[1] === 'pull')).toHaveLength(1)
  expect(logs).toEqual(['拉取 worker 镜像 ghcr.io/a/b-worker:v1'])
  const failing: Command = async (args) => {
    if (args[1] === 'pull') throw new Error('denied')
    throw new Error('No such image')
  }
  const tried = new Set<string>()
  expect(await ensureWorkerImage(failing, 'x:1', tried, () => {})).toContain(
    '拉取 worker 镜像 x:1 失败',
  )
  expect(await ensureWorkerImage(failing, 'x:1', tried, () => {})).toContain(
    '找不到 worker 镜像 x:1',
  )
})
