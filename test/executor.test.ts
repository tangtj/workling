import { dockerExecutor } from '../src/executor/docker.ts'
import { parseDockerInfo } from '../src/executor/docker-host.ts'
import { processExecutor } from '../src/executor/process.ts'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutor, workerEnv, type RunHandle, type StartSpec } from '../src/executor/index.ts'
import * as runtime from '../src/runtime/process.ts'
import { WORKER_CLI } from '../src/runtime/paths.ts'
import type { Command, RunOptions } from '../src/runtime/types.ts'
import { parseExecutorSettings } from '../src/config/executor.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.each([
  ['GH_TOKEN', false],
  ['GH_HOST', false],
  ['GITHUB_TOKEN', false],
  ['GITLAB_TOKEN', false],
  ['WORKLING_UPDATE_TOKEN', false],
  ['WORKLING_LLM_API_KEY', false],
  ['WORKLING_PORT', false],
  ['PATH', true],
  ['HOME', true],
  ['WORKLING_WORKSPACE', true],
  ['WORKLING_CODEX_SANDBOX', true],
  ['WORKLING_TASK_TEE', true],
  ['WORKLING_GITLAB_HOST', true],
] as const)('worker 环境过滤 %s（保留：%s）', (name, keep) => {
  const base = { [name]: 'original' }
  expect(workerEnv(base)).toEqual(keep ? base : {})
  expect(base[name]).toBe('original')
})

function dockerInfo(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    CgroupVersion: '2',
    MemoryLimit: true,
    CpuCfsQuota: true,
    PidsLimit: true,
    SecurityOptions: ['name=seccomp,profile=builtin'],
    ...overrides,
  })
}

async function scenario(network?: string) {
  const taskDir = await mkdtemp(join(tmpdir(), 'workling-executor-'))
  dirs.push(taskDir)
  const config = parseExecutorSettings({ taskNetwork: network })
  const spec: StartSpec = {
    runId: 12,
    ref: 'github:a/b#42',
    taskDir,
    env: {
      ...process.env,
      GH_TOKEN: 'distinctive-fake-token',
      WORKLING_LLM_API_KEY: 'distinctive-fake-key',
      WORKLING_UPDATE_TOKEN: 'distinctive-fake-update-token',
      WORKLING_GITLAB_HOST: network ? 'gitlab.example' : '',
      WORKLING_MODEL: 'gpt-6.1-terra',
      WORKLING_PI_MODEL: undefined,
      UNRELATED_SECRET: 'excluded',
    },
  }
  const handle: RunHandle = { pid: null, container: 'workling-run-12', taskDir }
  return { config, spec, handle }
}

test.each([undefined, 'workling-network'])(
  'docker run 参数、权限、单一挂载与环境隔离符合规格，网络=%s',
  async (network) => {
    const { config, spec } = await scenario(network)
    const calls: { args: string[]; options?: RunOptions }[] = []
    const executor = dockerExecutor({
      config,
      log: () => {},
      command: async (args, options) => {
        if (args[1] === 'info') return dockerInfo()
        calls.push({ args, options })
        return 'container-id'
      },
    })
    expect(await executor.start(spec)).toEqual({ container: 'workling-run-12' })
    const inner = `/data/tasks/${spec.taskDir.split('/').at(-1)}`
    const env = {
      ...spec.env,
      HOME: `${inner}/home`,
      WORKLING_WORKSPACE: '/data',
      WORKLING_CODEX_SANDBOX: 'danger-full-access',
      WORKLING_TASK_TEE: '1',
    }
    const keys = ['HOME', 'WORKLING_WORKSPACE', 'WORKLING_CODEX_SANDBOX', 'WORKLING_TASK_TEE']
    if (network) keys.push('WORKLING_GITLAB_HOST')
    expect(calls).toEqual([
      {
        args: [
          'docker',
          'run',
          '-d',
          '--name',
          'workling-run-12',
          '--label',
          'workling.run=12',
          '--label',
          'workling.issue=github:a/b#42',
          '--init',
          '--user',
          `${process.getuid!()}:${process.getgid!()}`,
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--cpus',
          '2',
          '--memory',
          '4g',
          '--pids-limit',
          '1024',
          ...(network ? ['--network', network] : []),
          '-v',
          `${spec.taskDir}:${inner}`,
          ...keys.flatMap((key) => ['-e', key]),
          'workling:local',
          'bun',
          '--no-env-file',
          'worker/cli.ts',
          'task',
          spec.ref,
          inner,
        ],
        options: { env },
      },
    ])
    const args = calls[0]!.args
    expect(args.filter((arg) => arg === '-v')).toHaveLength(1)
    for (const forbidden of [
      'docker.sock',
      'workling.db',
      'distinctive-fake-token',
      'distinctive-fake-key',
      'UNRELATED_SECRET',
    ])
      expect(args.join(' ')).not.toContain(forbidden)
    for (const [i, arg] of args.entries()) if (arg === '-e') expect(args[i + 1]).not.toContain('=')
    expect((await stat(join(spec.taskDir, 'home'))).mode & 0o777).toBe(0o700)
  },
)

test('docker start 使用自定义资源与镜像并透传命令失败', async () => {
  const { config, spec } = await scenario()
  const executor = dockerExecutor({
    config: {
      ...config,
      taskCpus: 1.5,
      taskMemory: '512m',
      taskPids: 64,
      taskImage: 'custom:tag',
    },
    log: () => {},
    command: async (args) => {
      if (args[1] === 'info') return dockerInfo()
      for (const [flag, value] of [
        ['--cpus', '1.5'],
        ['--memory', '512m'],
        ['--pids-limit', '64'],
      ])
        expect(args[args.indexOf(flag!) + 1]).toBe(value)
      expect(args).toContain('custom:tag')
      throw new Error('docker failed')
    },
  })
  await expect(executor.start(spec)).rejects.toThrow('docker failed')
})

test.each([
  ['true false', { running: true }],
  ['false false', { running: false }],
  ['false true\n', { running: false, oom: true }],
])('docker status 解析 inspect 输出 %s', async (output, expected) => {
  const { config, handle } = await scenario()
  const executor = dockerExecutor({
    config,
    log: () => {},
    command: async (args) => {
      expect(args).toEqual([
        'docker',
        'inspect',
        '-f',
        '{{.State.Running}} {{.State.OOMKilled}}',
        handle.container!,
      ])
      return output
    },
  })
  expect(await executor.status(handle)).toEqual(expected)
})

test('docker 容器不存在时 status 返回停止且 signal 不抛错，存在时保留 kill 错误', async () => {
  const { config, handle } = await scenario()
  const calls: string[][] = []
  let missing = true
  const executor = dockerExecutor({
    config,
    log: () => {},
    command: async (args) => {
      calls.push(args)
      if (missing || args[1] === 'kill') throw new Error('docker failed')
      return ''
    },
  })
  expect(await executor.status(handle)).toEqual({ running: false })
  await executor.signal(handle, 'SIGTERM')
  expect(calls[1]).toEqual(['docker', 'kill', '-s', 'SIGTERM', handle.container!])
  missing = false
  await expect(executor.signal(handle, 'SIGKILL')).rejects.toThrow('docker failed')
  expect(calls[3]).toEqual(['docker', 'kill', '-s', 'SIGKILL', handle.container!])
})

test('docker finish 写入容器日志且保留任务日志后删除容器，两步失败均只记日志并继续清理', async () => {
  const { config, handle } = await scenario()
  const path = join(handle.taskDir, 'task.log')
  await writeFile(path, 'previous\n')
  const calls: string[][] = []
  const logs: string[] = []
  let fail = false
  const executor = dockerExecutor({
    config,
    log: (line) => logs.push(line),
    command: async (args) => {
      calls.push(args)
      if (fail) throw new Error('unavailable')
      return args[0] === 'sh' ? 'stdout\nstderr' : ''
    },
  })
  await executor.finish(handle)
  expect(calls).toEqual([
    ['sh', '-c', 'docker logs "$1" 2>&1', 'sh', handle.container!],
    ['docker', 'rm', '-f', handle.container!],
  ])
  expect(await readFile(path, 'utf8')).toBe('previous\n')
  expect(await readFile(join(handle.taskDir, 'container.log'), 'utf8')).toBe('stdout\nstderr')
  fail = true
  await executor.finish(handle)
  expect(logs).toEqual([
    'workling-run-12 收集日志失败：unavailable',
    'workling-run-12 删除容器失败：unavailable',
  ])
  expect(calls).toHaveLength(4)
})

test('docker finish 的固定 shell 脚本实际合并 stdout 与 stderr', async () => {
  const { config, handle } = await scenario()
  const docker = join(handle.taskDir, 'docker')
  await writeFile(
    docker,
    '#!/bin/sh\nif [ "$1" = logs ]; then\n  printf "out\\n"\n  printf "err\\n" >&2\nfi\n',
  )
  await chmod(docker, 0o700)
  const logs: string[] = []
  const executor = dockerExecutor({
    config,
    log: (line) => logs.push(line),
    command: (args) =>
      runtime.run(args, { env: { ...process.env, PATH: `${handle.taskDir}:${process.env.PATH}` } }),
  })
  await executor.finish(handle)
  expect(await readFile(join(handle.taskDir, 'container.log'), 'utf8')).toBe('out\nerr')
  expect(logs).toEqual([])
})

test('processExecutor 保持 launch 参数与日志、isTaskAlive 校验、killGroup 信号及空 finish 行为', async () => {
  const { spec, handle } = await scenario()
  const executor = processExecutor({
    launch(args, options) {
      expect(args).toEqual([
        process.execPath,
        '--no-env-file',
        WORKER_CLI,
        'task',
        spec.ref,
        spec.taskDir,
      ])
      expect(options).toEqual({ env: spec.env, log: join(spec.taskDir, 'task.log') })
      return 123
    },
  })
  expect(await executor.start(spec)).toEqual({ pid: 123 })
  const alive = spyOn(runtime, 'isTaskAlive').mockReturnValue(true)
  const kill = spyOn(runtime, 'killGroup').mockImplementation(() => {})
  const running = { ...handle, pid: 123, container: null }
  expect(await executor.status(running)).toEqual({ running: true })
  expect(alive).toHaveBeenCalledWith(123, spec.taskDir)
  alive.mockReturnValue(false)
  expect(await executor.status(running)).toEqual({ running: false })
  expect(await executor.status({ ...running, pid: null })).toEqual({ running: false })
  await executor.signal(running, 'SIGTERM')
  await executor.signal(running, 'SIGKILL')
  expect(kill.mock.calls).toEqual([
    [123, 'SIGTERM'],
    [123, 'SIGKILL'],
  ])
  await executor.finish(running)
  expect(await Bun.file(join(spec.taskDir, 'task.log')).exists()).toBe(false)
})

test('createExecutor 按配置启动进程或 Docker，日志错误交给传入的日志函数', async () => {
  const { config, spec, handle } = await scenario()
  const launch = spyOn(runtime, 'launch').mockReturnValue(321)
  const calls: string[][] = []
  const command: Command = async (args) => {
    if (args[1] === 'info') return dockerInfo()
    calls.push(args)
    return ''
  }
  expect(await createExecutor(config, command).start(spec)).toEqual({ pid: 321 })
  expect(launch).toHaveBeenCalledTimes(1)
  expect(await createExecutor({ ...config, sandbox: 'docker' }, command).start(spec)).toEqual({
    container: 'workling-run-12',
  })
  expect(calls[0]!.slice(0, 3)).toEqual(['docker', 'run', '-d'])
  const logs: string[] = []
  await createExecutor(
    config,
    async () => {
      throw new Error('missing')
    },
    (line) => logs.push(line),
  ).finish(handle)
  expect(logs).toHaveLength(2)
})

test.each(['none', 'docker'] as const)(
  '当前配置为 %s 时按运行的 container 路由 status、signal 和 finish',
  async (sandbox) => {
    const { config, handle } = await scenario()
    const calls: string[][] = []
    const executor = createExecutor({ ...config, sandbox }, async (args) => {
      calls.push(args)
      return args[0] === 'docker' && args[1] === 'inspect' ? 'true false' : 'logs'
    })
    expect(await executor.status(handle)).toEqual({ running: true })
    await executor.signal(handle, 'SIGTERM')
    await executor.finish(handle)
    expect(calls).toEqual([
      ['docker', 'inspect', '-f', '{{.State.Running}} {{.State.OOMKilled}}', handle.container!],
      ['docker', 'kill', '-s', 'SIGTERM', handle.container!],
      ['sh', '-c', 'docker logs "$1" 2>&1', 'sh', handle.container!],
      ['docker', 'rm', '-f', handle.container!],
    ])
    const alive = spyOn(runtime, 'isTaskAlive').mockReturnValue(true)
    const kill = spyOn(runtime, 'killGroup').mockImplementation(() => {})
    const processRun = { ...handle, container: null, pid: 123 }
    expect(await executor.status(processRun)).toEqual({ running: true })
    await executor.signal(processRun, 'SIGKILL')
    await executor.finish(processRun)
    expect(alive).toHaveBeenCalledWith(123, handle.taskDir)
    expect(kill).toHaveBeenCalledWith(123, 'SIGKILL')
    expect(calls).toHaveLength(4)
  },
)

// 真实容器用例依赖本地构建的默认任务镜像；CI 机器有 Docker 但没有该镜像时跳过，避免去远端拉取失败。
const dockerAvailable = (() => {
  try {
    const docker = (...args: string[]) =>
      spawnSync('docker', args, { stdio: 'ignore', timeout: 5000 }).status === 0
    return docker('info') && docker('image', 'inspect', parseExecutorSettings({}).taskImage)
  } catch {
    return false
  }
})()

test.skipIf(!dockerAvailable)(
  '真实 Docker 容器可写单一挂载且属主正确，status、signal、finish 生效并合并 stderr',
  async () => {
    const { config, spec } = await scenario()
    spec.runId = Date.now()
    const inner = `/data/tasks/${spec.taskDir.split('/').at(-1)}`
    const command: Command = (args, options) => {
      if (args[0] === 'docker' && args[1] === 'run') {
        const image = args.indexOf(config.taskImage)
        args = [
          ...args.slice(0, image + 1),
          'bun',
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(`${inner}/written`)}, 'ok'); console.log('out'); console.error('err'); setInterval(() => {}, 1000)`,
        ]
      }
      return runtime.run(args, options)
    }
    const executor = dockerExecutor({ command, config, log: () => {} })
    const handle = { pid: null, container: `workling-run-${spec.runId}`, taskDir: spec.taskDir }
    try {
      expect(await executor.start(spec)).toEqual({ container: handle.container })
      const path = join(spec.taskDir, 'written')
      for (let i = 0; i < 200 && !(await Bun.file(path).exists()); i++) await Bun.sleep(25)
      expect(await readFile(path, 'utf8')).toBe('ok')
      expect((await stat(path)).uid).toBe(process.getuid!())
      expect(await executor.status(handle)).toEqual({ running: true })
      await executor.signal(handle, 'SIGTERM')
      for (let i = 0; i < 200 && (await executor.status(handle)).running; i++) await Bun.sleep(25)
      expect(await executor.status(handle)).toEqual({ running: false })
      await executor.finish(handle)
      const logs = await readFile(join(spec.taskDir, 'container.log'), 'utf8')
      expect(logs).toContain('out')
      expect(logs).toContain('err')
      await expect(runtime.run(['docker', 'inspect', handle.container])).rejects.toThrow()
      await executor.signal(handle, 'SIGKILL')
    } finally {
      await command(['docker', 'rm', '-f', handle.container]).catch(() => {})
    }
  },
  30000,
)

test('rootless Docker 以容器内 root 运行 worker，cgroup 限制不可用时拒绝拉起', async () => {
  const { config, spec } = await scenario()
  let info = dockerInfo({ SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'] })
  const runs: string[][] = []
  const executor = dockerExecutor({
    config,
    log: () => {},
    command: async (args) => {
      if (args[1] === 'info') return info
      runs.push(args)
      return 'id'
    },
  })
  await executor.start(spec)
  expect(runs[0]![runs[0]!.indexOf('--user') + 1]).toBe('0:0')
  info = dockerInfo({ PidsLimit: false })
  await expect(executor.start({ ...spec, runId: 13 })).rejects.toThrow('Docker 不支持进程数限制')
  expect(runs).toHaveLength(1)
})

test.each([
  [dockerInfo(), { rootless: false, error: null }],
  [
    dockerInfo({ SecurityOptions: ['name=rootless'], MemoryLimit: false, CpuCfsQuota: false }),
    {
      rootless: true,
      error: 'Docker 不支持内存、CPU 配额限制（rootless 需要为用户委派 cgroup 控制器）',
    },
  ],
  [
    dockerInfo({ CgroupVersion: '1' }),
    { rootless: false, error: 'Docker 使用 cgroup v1，worker 需要 cgroup v2' },
  ],
  ['oops', { rootless: false, error: '无法解析 docker info 的输出' }],
] as const)('parseDockerInfo %#', (raw, expected) => {
  expect(parseDockerInfo(raw)).toEqual(expected)
})
