import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as task from '../src/task/index.ts'
import * as taskDir from '../src/task/dir.ts'
import * as executors from '../src/executor/index.ts'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { repos } from '../src/db/schema.ts'
import { main } from '../src/cli.ts'
import * as version from '../src/runtime/version.ts'

describe('命令行入口', () => {
  afterEach(() => mock.restore())

  test('version、--version 与 -v 只输出 VERSION 或 dev', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const read = spyOn(version, 'readVersion').mockReturnValue('v1.2.3')
    for (const command of ['version', '--version', '-v']) {
      expect(await main([command])).toBe(0)
      expect(log.mock.calls.at(-1)).toEqual(['v1.2.3'])
      read.mockReturnValue('dev')
      expect(await main([command])).toBe(0)
      expect(log.mock.calls.at(-1)).toEqual(['dev'])
      read.mockReturnValue('v1.2.3')
    }
  })

  test('帮助与未知命令输出分组用法', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    expect(await main([])).toBe(0)
    expect(await main(['run', 'x'])).toBe(0)
    const usage = log.mock.calls[0]?.[0] as string
    expect(usage).toContain('用法：bun src/cli.ts <命令>')
    expect(usage).toContain('命令：')
    expect(usage).toContain('内部命令（由 watch 调用，不要手动运行）：')
    expect(usage).toContain('task <issue 引用> <任务目录>')
    expect(usage).not.toContain('read <issue 引用> <任务目录>')
    expect(usage).not.toContain('run')
    expect(log.mock.calls[1]?.[0]).toBe(usage)
    expect(await main(['read', 'github:a/b#1', '/tmp/task'])).toBe(0)
    expect(log.mock.calls[2]?.[0]).toBe(usage)
  })
})

test('reset-password 在临时工作区打印新密码并使会话失效', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { openDatabase } = await import('../src/db/index.ts')
  const { ensurePassword, hashToken } = await import('../src/web/auth.ts')
  const { admin, sessions } = await import('../src/db/schema.ts')
  const dir = await mkdtemp(join(tmpdir(), 'workling-cli-reset-'))
  const { db, close } = await openDatabase(dir)
  try {
    const oldPassword = await ensurePassword(db)
    db.insert(sessions)
      .values({
        id: hashToken('old'),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })
      .run()
    const child = Bun.spawn([process.execPath, resolve('src/cli.ts'), 'reset-password'], {
      env: { ...process.env, WORKLING_WORKSPACE: dir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    const password = /新的管理密码：([A-Za-z0-9_-]{24})/.exec(output)?.[1]
    expect(password).toBeDefined()
    expect(output).toContain('已登录的会话已全部失效')
    const account = db.select().from(admin).get()!
    expect(await Bun.password.verify(password!, account.passwordHash)).toBe(true)
    expect(await Bun.password.verify(oldPassword!, account.passwordHash)).toBe(false)
    expect(db.select().from(sessions).all()).toHaveLength(0)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('task 参数或目录非法时不写 result.json', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-cli-invalid-'))
  process.env.WORKLING_WORKSPACE = workspace
  try {
    await expect(main(['task'])).rejects.toThrow('用法')
    await expect(main(['task', 'bad', workspace])).rejects.toThrow('无法识别')
    await expect(main(['task', 'github:a/b#1', workspace])).rejects.toThrow('任务目录无效')
    await expect(main(['task', 'github:a/b#1', join(workspace, 'tasks')])).rejects.toThrow(
      '任务目录无效',
    )
    expect(await readdir(workspace)).toEqual([])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('task 仅在启用 WORKLING_TASK_TEE 时将进度同时写入日志', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-cli-tee-'))
  process.env.WORKLING_WORKSPACE = workspace
  try {
    for (const tee of [false, true]) {
      const dir = join(workspace, 'tasks', String(tee))
      await mkdir(dir, { recursive: true })
      if (tee) process.env.WORKLING_TASK_TEE = '1'
      else delete process.env.WORKLING_TASK_TEE
      spyOn(console, 'log').mockImplementation(() => {})
      spyOn(task, 'runTask').mockImplementation(async (options) => {
        options.out?.('进度')
        return { code: 0, signal: null }
      })
      expect(await main(['task', 'github:a/b#1', dir])).toBe(0)
      expect(await Bun.file(join(dir, 'task.log')).exists()).toBe(tee)
      if (tee) expect(await Bun.file(join(dir, 'task.log')).text()).toBe('进度\n')
      mock.restore()
    }
  } finally {
    mock.restore()
    delete process.env.WORKLING_TASK_TEE
    await rm(workspace, { recursive: true, force: true })
  }
})

test('task 没有契约时将校验失败写入 result.json', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-cli-spec-'))
  process.env.WORKLING_WORKSPACE = workspace
  try {
    const dir = join(workspace, 'tasks', 'missing-spec')
    await mkdir(dir, { recursive: true })
    expect(await main(['task', 'github:a/b#1', dir])).toBe(1)
    expect(await taskDir.readResult(dir)).toMatchObject({
      exitCode: null,
      signal: null,
      error: '缺少 spec.json',
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('task 写入 Pi 退出状态和产出错误，不注入模型和 Git 环境默认值', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-cli-task-'))
  process.env.WORKLING_WORKSPACE = workspace
  const oldExit = process.exitCode
  try {
    for (const kind of ['zero', 'nonzero', 'output-error', 'error', 'abort']) {
      const dir = join(workspace, 'tasks', kind)
      await mkdir(dir, { recursive: true })
      spyOn(task, 'runTask').mockImplementation(async (options) => {
        for (const name of [
          'WORKLING_MODEL',
          'WORKLING_EFFORT',
          'WORKLING_GIT_NAME',
          'WORKLING_GIT_EMAIL',
          'WORKLING_PI_MODEL',
        ])
          expect(options.env).not.toHaveProperty(name)
        if (kind === 'error') throw new Error('克隆失败')
        if (kind === 'output-error') return { code: 7, signal: null, error: '生成任务产出失败' }
        if (kind === 'abort') {
          process.emit('SIGTERM')
          expect(options.signal.aborted).toBe(true)
          throw new Error('进程已取消')
        }
        return { code: kind === 'zero' ? 0 : 7, signal: null }
      })
      const exitCode = await main(['task', 'github:a/b#1', dir])
      const result = await taskDir.readResult(dir)
      const expected = {
        zero: { exitCode: 0, signal: null },
        nonzero: { exitCode: 7, signal: null },
        'output-error': { exitCode: 7, signal: null, error: '生成任务产出失败' },
        error: { exitCode: null, signal: null, error: '克隆失败' },
        abort: { exitCode: null, signal: 'SIGTERM', error: '进程已取消' },
      }[kind]!
      expect(result).toMatchObject(expected)
      expect(exitCode).toBe(expected.exitCode ?? 1)
      expect(process.exitCode).toBe(oldExit)
      expect(result && result !== 'invalid' && Number.isNaN(Date.parse(result.finishedAt))).toBe(
        false,
      )
      mock.restore()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('cancel 缺少引用或引用非法时报错', async () => {
  await expect(main(['cancel'])).rejects.toThrow('用法：bun src/cli.ts cancel <issue 引用>')
  await expect(main(['cancel', 'bad'])).rejects.toThrow('无法识别')
})

test.each(['无仓库', '无 Issue', '非运行中', '无 run', 'run 不存在', '已结束', '无 pid'])(
  'cancel 在%s 时拒绝且不发信号',
  async (kind) => {
    const { issues, runs } = await import('../src/db/schema.ts')

    const workspace = await mkdtemp(join(tmpdir(), 'workling-cli-cancel-'))
    process.env.WORKLING_WORKSPACE = workspace
    const { db, close } = await openDatabase(workspace)
    try {
      const signal = mock(async () => {})
      spyOn(executors, 'createExecutor').mockReturnValue({
        async start() {
          return {}
        },
        async status() {
          return { running: false }
        },
        signal,
        async finish() {},
      })
      if (kind !== '无仓库') {
        const repo = db
          .insert(repos)
          .values({
            ref: 'github:a/b',
            platform: 'github',
            host: 'github.com',
            path: 'a/b',
            token: 'secret',
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning()
          .get()
        if (kind !== '无 Issue') {
          const issue = db
            .insert(issues)
            .values({
              repoId: repo.id,
              number: 42,
              status: kind === '非运行中' ? 'queued' : 'running',
              lastRunId: kind === '无 run' ? null : 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            .returning()
            .get()
          if (kind === '已结束' || kind === '无 pid')
            db.insert(runs)
              .values({
                issueId: issue.id,
                worker: 'worker',
                startedAt: new Date(),
                endedAt: kind === '已结束' ? new Date() : null,
                pid: kind === '无 pid' ? null : 123,
              })
              .run()
        }
      }
      await expect(main(['cancel', 'github:a/b#42'])).rejects.toThrow(
        '没有运行中的任务：github:a/b#42',
      )
      expect(signal).not.toHaveBeenCalled()
    } finally {
      mock.restore()
      close()
      await rm(workspace, { recursive: true, force: true })
    }
  },
)

test.each(['process', 'docker'])(
  'cancel 先记录已取消再经 %s 执行器发 SIGTERM，保留 Issue 状态标签并返回 0',
  async (kind) => {
    const { issues, runs } = await import('../src/db/schema.ts')
    const runtime = await import('../src/runtime/process.ts')
    const workspace = await mkdtemp(join(tmpdir(), 'workling-cli-cancel-'))
    process.env.WORKLING_WORKSPACE = workspace
    const { db, close } = await openDatabase(workspace)
    const oldExit = process.exitCode
    try {
      const repo = db
        .insert(repos)
        .values({
          ref: 'github:a/b',
          platform: 'github',
          host: 'github.com',
          path: 'a/b',
          token: 'secret',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .get()
      const issue = db
        .insert(issues)
        .values({
          repoId: repo.id,
          number: 42,
          status: 'running',
          lastRunId: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .get()
      db.insert(runs)
        .values({
          issueId: issue.id,
          worker: 'worker',
          pid: kind === 'process' ? 123 : null,
          container: kind === 'docker' ? 'workling-run-1' : null,
          taskDir: '/task',
          startedAt: new Date(),
        })
        .run()
      const status = mock(async (run: executors.RunHandle) => {
        expect(run).toMatchObject({
          pid: kind === 'process' ? 123 : null,
          container: kind === 'docker' ? 'workling-run-1' : null,
          taskDir: '/task',
        })
        return { running: true }
      })
      const signal = mock(async (run: executors.RunHandle, signal: 'SIGTERM' | 'SIGKILL') => {
        expect(db.select().from(runs).get()?.error).toBe('已取消')
        expect(run.taskDir).toBe('/task')
        expect(signal).toBe('SIGTERM')
      })
      spyOn(executors, 'createExecutor').mockReturnValue({
        async start() {
          return {}
        },
        status,
        signal,
        async finish() {},
      })
      const command = spyOn(runtime, 'run').mockImplementation(async () => {
        throw new Error('不应调用 gh')
      })
      const log = spyOn(console, 'log').mockImplementation(() => {})
      expect(await main(['cancel', 'github:a/b#42'])).toBe(0)
      expect(signal).toHaveBeenCalledTimes(1)
      expect(status).toHaveBeenCalledTimes(1)
      expect(command).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith('已发送取消信号，watch 下一轮对账后标记为 workling:failed')
      expect(db.select().from(issues).get()).toEqual(issue)
      expect(db.select().from(runs).get()?.endedAt).toBeNull()
      expect(process.exitCode).toBe(oldExit)
    } finally {
      mock.restore()
      close()
      await rm(workspace, { recursive: true, force: true })
    }
  },
)

test('cancel 遇到不属于任务的存活 pid 时拒绝，不记录取消也不发信号', async () => {
  const { issues, runs } = await import('../src/db/schema.ts')
  const workspace = await mkdtemp(join(tmpdir(), 'workling-cli-cancel-reused-'))
  process.env.WORKLING_WORKSPACE = workspace
  const { db, close } = await openDatabase(workspace)
  try {
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'secret',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .get()
    const issue = db
      .insert(issues)
      .values({
        repoId: repo.id,
        number: 42,
        status: 'running',
        lastRunId: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .get()
    db.insert(runs)
      .values({
        issueId: issue.id,
        worker: 'worker',
        pid: process.pid,
        taskDir: join(workspace, 'tasks', 'other'),
        startedAt: new Date(),
      })
      .run()
    const signal = mock(async () => {})
    spyOn(executors, 'createExecutor').mockReturnValue({
      async start() {
        return {}
      },
      async status() {
        return { running: false }
      },
      signal,
      async finish() {},
    })
    await expect(main(['cancel', 'github:a/b#42'])).rejects.toThrow(
      '没有运行中的任务：github:a/b#42',
    )
    expect(signal).not.toHaveBeenCalled()
    expect(db.select().from(runs).get()?.error).toBeNull()
  } finally {
    mock.restore()
    close()
    await rm(workspace, { recursive: true, force: true })
  }
})
