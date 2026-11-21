import { eq } from 'drizzle-orm'
import { processExecutor } from '../src/executor/process.ts'
import { expect, spyOn, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  admin,
  executorSettings,
  issues,
  piSettings,
  runs,
  upgradeSteps,
} from '../src/db/schema.ts'
import { readPiSettings } from '../src/config/pi.ts'
import { readExecutorSettings } from '../src/config/executor.ts'
import { launch, isAlive, killGroup } from '../src/runtime/process.ts'
import { launchQueued } from '../src/serve/launch.ts'
import { reconcile } from '../src/serve/reconcile.ts'
import { serve as startServe } from '../src/serve/index.ts'

import { scenario } from './helpers/serve.ts'

test('升级步骤失败使 serve 启动失败，不导入配置、不初始化密码、不对账、不监听端口', async () => {
  const s = await scenario()
  const listen = spyOn(Bun, 'serve')
  let upgradeDb: typeof s.db | undefined
  try {
    await expect(
      startServe({
        ...s.options,
        signal: new AbortController().signal,
        env: {},
        upgradeSteps: [
          {
            id: 'v0.3.0-01-failure',
            description: '测试启动失败',
            async run(ctx) {
              upgradeDb = ctx.db
              throw new Error('升级中断')
            },
          },
        ],
      }),
    ).rejects.toThrow('升级步骤 v0.3.0-01-failure 失败：升级中断')
    expect(listen).not.toHaveBeenCalled()
    expect(s.db.select().from(upgradeSteps).all()).toEqual([])
    expect(s.db.select().from(piSettings).all()).toEqual([])
    expect(s.db.select().from(executorSettings).all()).toEqual([])
    expect(s.db.select().from(admin).all()).toEqual([])
    expect(s.calls).toEqual([])
    expect(() => upgradeDb!.select().from(upgradeSteps).all()).toThrow()
  } finally {
    listen.mockRestore()
    await s.dispose()
  }
})

test('正常升级步骤先于配置导入、密码初始化和对账，成功登记后才监听且重启不重复执行', async () => {
  const s = await scenario()
  const controller = new AbortController()
  controller.abort()
  let ran = 0
  let stopped = 0
  const listen = spyOn(Bun, 'serve').mockImplementation(() => {
    expect(s.db.select().from(upgradeSteps).all()).toHaveLength(1)
    expect(readPiSettings(s.db).model).toBe('after-upgrade')
    expect(s.db.select().from(executorSettings).all()).toHaveLength(1)
    expect(s.db.select().from(admin).all()).toHaveLength(1)
    return {
      port: 0,
      stop() {
        stopped++
      },
    } as ReturnType<typeof Bun.serve>
  })
  try {
    for (let i = 0; i < 2; i++)
      await startServe({
        ...s.options,
        signal: controller.signal,
        env: { WORKLING_MODEL: 'after-upgrade' },
        upgradeSteps: [
          {
            id: 'v0.3.0-01-before-import',
            description: '测试配置导入前执行',
            async run(ctx) {
              ran++
              expect(ctx.workspace).toBe(s.workspace)
              expect(ctx.db.select().from(piSettings).all()).toEqual([])
              expect(ctx.db.select().from(executorSettings).all()).toEqual([])
              expect(ctx.db.select().from(admin).all()).toEqual([])
              expect(s.calls).toEqual([])
            },
          },
        ],
      })
    expect(ran).toBe(1)
    expect(listen).toHaveBeenCalledTimes(2)
    expect(stopped).toBe(2)
  } finally {
    listen.mockRestore()
    await s.dispose()
  }
})

test('watch 子进程启动本地接口并在 SIGTERM 后正常退出', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-child-'))
  await writeFile(join(dir, 'gh'), '#!/bin/sh\necho "[]"\n')
  await chmod(join(dir, 'gh'), 0o755)
  const child = Bun.spawn([process.execPath, resolve('src/cli.ts'), 'serve'], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      WORKLING_WORKSPACE: dir,
      WORKLING_PORT: '0',
      WORKLING_WORKER: 'test-worker',
      WORKLING_INTERVAL: '60',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
  try {
    const reader = child.stdout.getReader()
    let output = ''
    let address: string | undefined
    while (!address) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`watch 提前退出：${await new Response(child.stderr).text()}`)
      output += new TextDecoder().decode(chunk.value)
      address = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]
    }
    const password = /只显示这一次）：\s*([A-Za-z0-9_-]{24})/.exec(output)?.[1]
    expect(password).toBeDefined()
    const login = await fetch(`${address}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    expect(login.status).toBe(204)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const status = await (await fetch(`${address}/api/status`, { headers: { cookie } })).json()
    expect(status.watch).toEqual({
      worker: 'test-worker',
      interval: 60,
      timeout: 90,
      startedAt: expect.any(String),
      lastPollAt: expect.any(String),
      lastPollError: null,
      workerError: null,
    })
    expect(Number.isFinite(Date.parse(status.watch.lastPollAt))).toBe(true)
    expect(new Date(status.watch.startedAt).toISOString()).toBe(status.watch.startedAt)
    const created = await fetch(`${address}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ref: 'github:a/b', token: 'secret' }),
    })
    expect(created.status).toBe(201)
    const list = await (await fetch(`${address}/api/repos`, { headers: { cookie } })).json()
    expect(list).toHaveLength(1)
    expect(list[0].ref).toBe('github:a/b')
    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)
  } finally {
    clearTimeout(timeout)
    child.kill('SIGKILL')
    await child.exited
    await rm(dir, { recursive: true, force: true })
  }
}, 15000)

test('watch 启动先对账，仍存活的独立 task 保持 running 且停止 watch 不结束 task', async () => {
  const s = await scenario()
  const dir = join(s.workspace, 'tasks', 'a-b-42-20261114T103000Z')
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)', dir])
  const runtime = await import('../src/runtime/process.ts')
  const alive = spyOn(runtime, 'isTaskAlive').mockImplementation(
    (pid, taskDir) => pid === child.pid && taskDir === dir,
  )
  try {
    await s.running({ pid: child.pid, startedAt: new Date() })
    const missing = await s.issue(1)
    const controller = new AbortController()
    controller.abort()
    let stopped = false
    const serve = spyOn(Bun, 'serve').mockImplementation(() => {
      expect(s.db.select().from(issues).where(eq(issues.number, 42)).get()?.status).toBe('running')
      expect(s.db.select().from(issues).where(eq(issues.id, missing.id)).get()?.status).toBe(
        'failed',
      )
      expect(s.db.select().from(runs).get()?.endedAt).toBeNull()
      return {
        port: 0,
        stop() {
          stopped = true
        },
      } as ReturnType<typeof Bun.serve>
    })
    await startServe({ ...s.options, signal: controller.signal })
    expect(serve).toHaveBeenCalledTimes(1)
    expect(stopped).toBe(true)
    expect(isAlive(child.pid)).toBe(true)
    expect(s.db.select().from(issues).where(eq(issues.number, 42)).get()?.status).toBe('running')
    serve.mockRestore()
  } finally {
    alive.mockRestore()
    child.kill()
    await child.exited
    await s.dispose()
  }
})

test('端到端真实 task 子进程写 result 后对账完成，记录 pid 和 queued→running→done 标签序列', async () => {
  const s = await scenario()
  let pid: number | undefined
  try {
    await s.issue(42, 'queued')
    await launchQueued({
      ...s.options,
      executor: processExecutor({
        launch(args, options) {
          pid = launch(
            [process.execPath, resolve('test/fixtures/watch-task.ts'), args.at(-1)!],
            options,
          )
          return pid
        },
      }),
    })
    expect(s.db.select().from(runs).get()?.pid).toBe(pid!)
    const deadline = Date.now() + 5000
    while (isAlive(pid!) && Date.now() < deadline) await Bun.sleep(10)
    expect(isAlive(pid!)).toBe(false)
    await reconcile(s.options)
    expect(s.db.select().from(issues).get()?.status).toBe('done')
    expect(s.db.select().from(runs).get()).toMatchObject({
      pid,
      exitCode: 0,
      error: null,
      endedAt: expect.any(Date),
    })
    expect(s.calls.filter((call) => call.args[2] === 'edit').map((call) => call.args)).toEqual([
      [
        'gh',
        'issue',
        'edit',
        '42',
        '-R',
        'a/b',
        '--remove-label',
        'workling:queued',
        '--add-label',
        'workling:running',
      ],
      [
        'gh',
        'issue',
        'edit',
        '42',
        '-R',
        'a/b',
        '--remove-label',
        'workling:running',
        '--add-label',
        'workling:done',
      ],
    ])
  } finally {
    if (pid) killGroup(pid, 'SIGKILL')
    await s.dispose()
  }
})

test('watch 启动从注入环境导入，后续启动忽略旧环境变量，非法首次导入使启动失败', async () => {
  const s = await scenario()
  const controller = new AbortController()
  controller.abort()
  const serve = spyOn(Bun, 'serve').mockReturnValue({ port: 0, stop() {} } as ReturnType<
    typeof Bun.serve
  >)
  try {
    await expect(
      startServe({ ...s.options, signal: controller.signal, env: { WORKLING_EFFORT: 'invalid' } }),
    ).rejects.toThrow('WORKLING_EFFORT')
    expect(serve).not.toHaveBeenCalled()
    process.env.WORKLING_MODEL = 'ambient-model'
    await startServe({
      ...s.options,
      signal: controller.signal,
      env: { WORKLING_MODEL: 'imported-model', WORKLING_EFFORT: 'high' },
    })
    expect(readPiSettings(s.db)).toMatchObject({ model: 'imported-model', effort: 'high' })
    expect(s.logs).toContain('已从环境变量导入 Pi 配置')
    await startServe({
      ...s.options,
      signal: controller.signal,
      env: { WORKLING_MODEL: 'ignored-model', WORKLING_EFFORT: 'invalid' },
    })
    expect(readPiSettings(s.db)).toMatchObject({ model: 'imported-model', effort: 'high' })
    expect(s.logs).toContain(
      '以下环境变量已不再生效，请在设置页修改：WORKLING_MODEL、WORKLING_EFFORT',
    )
  } finally {
    serve.mockRestore()
    await s.dispose()
  }
})

test('docker 执行器的 worker 镜像不兼容时暂停拉起并记录原因', async () => {
  const s = await scenario()
  const controller = new AbortController()
  const logs: string[] = []
  const listen = spyOn(Bun, 'serve').mockImplementation(
    () => ({ port: 0, stop() {} }) as unknown as ReturnType<typeof Bun.serve>,
  )
  try {
    await s.issue(42, 'queued')
    await startServe({
      ...s.options,
      signal: controller.signal,
      env: { WORKLING_SANDBOX: 'docker', WORKLING_TASK_IMAGE: 'old:1' },
      log: (message) => {
        logs.push(message)
        if (message.startsWith('暂停拉起新任务')) controller.abort()
      },
    })
    expect(logs).toContain('暂停拉起新任务：无法解析 docker info 的输出')
    expect(s.calls.some(({ args }) => args[0] === 'docker' && args[1] === 'run')).toBe(false)
    expect(s.db.select().from(runs).all()).toEqual([])
  } finally {
    listen.mockRestore()
    await s.dispose()
  }
})

test('WORKLING_REQUIRE_DOCKER=true 时启动切换为 Docker 执行器，WORKLING_WORKER_IMAGE 覆盖任务镜像', async () => {
  const s = await scenario()
  const controller = new AbortController()
  const logs: string[] = []
  const listen = spyOn(Bun, 'serve').mockImplementation(
    () => ({ port: 0, stop() {} }) as unknown as ReturnType<typeof Bun.serve>,
  )
  try {
    await s.issue(42, 'queued')
    await startServe({
      ...s.options,
      settings: { ...s.options.settings, requireDocker: true },
      signal: controller.signal,
      env: { WORKLING_WORKER_IMAGE: 'ghcr.io/a/b-worker:v9' },
      log: (message) => {
        logs.push(message)
        if (message.startsWith('暂停拉起新任务')) controller.abort()
      },
    })
    expect(logs).toContain('已按 WORKLING_REQUIRE_DOCKER=true 切换为 Docker 执行器')
    expect(logs).toContain('任务镜像已按 WORKLING_WORKER_IMAGE 设为 ghcr.io/a/b-worker:v9')
    expect(readExecutorSettings(s.db)).toMatchObject({
      sandbox: 'docker',
      taskImage: 'ghcr.io/a/b-worker:v9',
    })
    expect(s.db.select().from(runs).all()).toEqual([])
  } finally {
    listen.mockRestore()
    await s.dispose()
  }
})
