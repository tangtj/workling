import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as taskDir from '../src/contract/result.ts'
import { main } from '../worker/cli.ts'
import * as task from '../worker/task.ts'

afterEach(() => mock.restore())

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
