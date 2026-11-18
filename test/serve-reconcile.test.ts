import { eq } from 'drizzle-orm'
import { processExecutor } from '../src/executor/process.ts'
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { issues, runs } from '../src/db/schema.ts'
import { writeResult } from '../src/task/dir.ts'
import { reconcile } from '../src/serve/reconcile.ts'
import { fakeExecutor, clock, scenario } from './helpers/serve.ts'

test('对账退出码 0 查询首个匹配 PR 后 done，保存链接与结果时间并安全删除 repo', async () => {
  const s = await scenario()
  try {
    const { dir } = await s.running()
    await mkdir(join(dir, 'repo'))
    await writeFile(join(dir, 'report.md'), '保留')
    await writeResult(dir, { exitCode: 0, signal: null, finishedAt: '2026-11-14T10:29:59Z' })
    await reconcile(s.options)
    expect(s.db.select().from(issues).get()).toMatchObject({
      status: 'done',
      prUrl: 'https://github.com/a/b/pull/1',
      prState: 'open',
    })
    expect(s.db.select().from(runs).get()).toMatchObject({
      endedAt: new Date('2026-11-14T10:29:59Z'),
      exitCode: 0,
      error: null,
    })
    expect((await readdir(dir)).sort()).toEqual(['report.md', 'result.json'])
    expect(s.calls.map((call) => call.args)).toEqual([
      [
        'gh',
        'pr',
        'list',
        '-R',
        'a/b',
        '--state',
        'all',
        '--search',
        'head:workling/42-',
        '--json',
        'url,headRefName,state',
        '--limit',
        '20',
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
    await s.dispose()
  }
})

test('对账退出码 0 无匹配 PR 判为未找到 PR，不能只按退出码判成功', async () => {
  const s = await scenario()
  try {
    const { dir } = await s.running()
    await writeResult(dir, { exitCode: 0, signal: null, finishedAt: 'invalid date' })
    await reconcile({
      ...s.options,
      command: async (args, options) => {
        s.calls.push({ args, options })
        return args[1] === 'pr'
          ? '[{"url":"wrong","headRefName":"workling/420-task","state":"OPEN"}]'
          : ''
      },
    })
    expect(s.db.select().from(issues).get()?.status).toBe('failed')
    expect(s.db.select().from(runs).get()).toMatchObject({
      error: '未找到 PR',
      endedAt: clock,
      exitCode: 0,
    })
  } finally {
    await s.dispose()
  }
})

test.each(['命令失败', 'JSON 无效', '形状无效'])(
  'PR 查询%s 本轮跳过且下一轮可完成',
  async (kind) => {
    const s = await scenario()
    try {
      const { dir } = await s.running()
      await writeResult(dir, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
      await reconcile({
        ...s.options,
        command: async () => {
          if (kind === '命令失败') throw new Error('API failed')
          return kind === 'JSON 无效' ? '{' : '[{"url":1,"headRefName":"workling/42-task"}]'
        },
      })
      expect(s.db.select().from(issues).get()?.status).toBe('running')
      expect(s.db.select().from(runs).get()?.endedAt).toBeNull()
      expect(s.logs).toHaveLength(1)
      await reconcile(s.options)
      expect(s.db.select().from(issues).get()?.status).toBe('done')
    } finally {
      await s.dispose()
    }
  },
)

test.each([
  { runError: '超时', resultError: 'task failed', signal: 'SIGTERM', code: 7, reason: '超时' },
  {
    runError: undefined,
    resultError: 'task failed',
    signal: 'SIGTERM',
    code: 0,
    reason: 'task failed',
  },
  {
    runError: undefined,
    resultError: undefined,
    signal: 'SIGTERM',
    code: null,
    reason: '信号 SIGTERM',
  },
  { runError: undefined, resultError: undefined, signal: null, code: 7, reason: '退出码 7' },
])(
  '对账失败原因优先级：$reason，且不查询 PR',
  async ({ runError, resultError, signal, code, reason }) => {
    const s = await scenario()
    try {
      const { dir } = await s.running({ error: runError })
      await writeResult(dir, {
        exitCode: code,
        signal,
        error: resultError,
        finishedAt: clock.toISOString(),
      })
      await reconcile(s.options)
      expect(s.db.select().from(runs).get()).toMatchObject({
        error: reason,
        exitCode: code,
        endedAt: clock,
      })
      expect(s.db.select().from(issues).get()?.status).toBe('failed')
      expect(s.calls.some((call) => call.args[1] === 'pr')).toBe(false)
    } finally {
      await s.dispose()
    }
  },
)

test.each(['{', '{"exitCode":"0"}'])('result.json 无效优先于取消且不检查进程：%s', async (raw) => {
  const s = await scenario()
  try {
    const { dir } = await s.running({ error: '已取消' })
    await writeFile(join(dir, 'result.json'), raw)
    await reconcile({
      ...s.options,
      executor: fakeExecutor({
        async status() {
          throw new Error('不应检查进程')
        },
      }),
    })
    expect(s.db.select().from(runs).get()?.error).toBe('result.json 无效')
    expect(s.db.select().from(issues).get()?.status).toBe('failed')
  } finally {
    await s.dispose()
  }
})

test('进程仍在且未超时保持，超过时限先 SIGTERM 记超时，下轮 SIGKILL，消失后失败', async () => {
  const s = await scenario()
  try {
    const { run } = await s.running({ startedAt: clock })
    const kills: [number, NodeJS.Signals][] = []
    const options = {
      ...s.options,
      executor: fakeExecutor({
        async status() {
          return { running: true }
        },
        async signal(run, signal) {
          kills.push([run.pid!, signal])
        },
      }),
    }
    await reconcile({ ...options, now: () => new Date(clock.getTime() + 60_000) })
    expect(kills).toEqual([])
    expect(s.db.select().from(runs).get()?.error).toBeNull()
    await reconcile({ ...options, now: () => new Date(clock.getTime() + 60_001) })
    expect(kills).toEqual([[run.pid!, 'SIGTERM']])
    expect(s.db.select().from(runs).get()?.error).toBe('超时')
    await reconcile(options)
    expect(kills).toEqual([
      [run.pid!, 'SIGTERM'],
      [run.pid!, 'SIGKILL'],
    ])
    expect(s.db.select().from(issues).get()?.status).toBe('running')
    await reconcile({ ...options, executor: fakeExecutor() })
    expect(s.db.select().from(issues).get()?.status).toBe('failed')
    expect(s.db.select().from(runs).get()).toMatchObject({ error: '超时', endedAt: clock })
  } finally {
    await s.dispose()
  }
})

test.each([null, 123])('无结果且 pid=%s 进程不在时记录进程丢失', async (pid) => {
  const s = await scenario()
  try {
    await s.running({ pid })
    await reconcile({ ...s.options, executor: fakeExecutor() })
    expect(s.db.select().from(runs).get()).toMatchObject({ error: '进程丢失', endedAt: clock })
    expect(s.db.select().from(issues).get()?.status).toBe('failed')
  } finally {
    await s.dispose()
  }
})

test('pid 存活但不属于该任务时按进程丢失收尾且不发信号', async () => {
  const s = await scenario()
  try {
    await s.running({ pid: process.pid })
    const kills: NodeJS.Signals[] = []
    await reconcile({
      ...s.options,
      executor: {
        ...processExecutor(),
        async signal(_run, signal) {
          kills.push(signal)
        },
      },
    })
    expect(s.db.select().from(runs).get()).toMatchObject({ error: '进程丢失', endedAt: clock })
    expect(s.db.select().from(issues).get()?.status).toBe('failed')
    expect(kills).toEqual([])
  } finally {
    await s.dispose()
  }
})

test.each(['有结果', '无结果', '仍存活'])(
  '已取消优先判 canceled：%s，存活时先 SIGKILL 等待对账',
  async (kind) => {
    const s = await scenario()
    try {
      const { dir } = await s.running({ error: '已取消' })
      if (kind === '有结果')
        await writeResult(dir, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
      const kills: NodeJS.Signals[] = []
      await reconcile({
        ...s.options,
        executor: fakeExecutor({
          async status() {
            return { running: kind === '仍存活' }
          },
          async signal(_run, signal) {
            kills.push(signal)
          },
        }),
      })
      expect(s.db.select().from(issues).get()?.status).toBe(
        kind === '仍存活' ? 'running' : 'canceled',
      )
      expect(s.calls.some((call) => call.args[1] === 'pr')).toBe(false)
      expect(kills).toEqual(kind === '仍存活' ? ['SIGKILL'] : [])
      if (kind !== '仍存活') expect(s.db.select().from(runs).get()?.error).toBe('已取消')
    } finally {
      await s.dispose()
    }
  },
)

test.each(['无 run', 'run 不存在', '无目录'])('缺少任务目录优先判失败：%s', async (kind) => {
  const s = await scenario()
  try {
    if (kind === '无目录') await s.running({ taskDir: null })
    else {
      const row = await s.issue()
      if (kind === 'run 不存在')
        s.db.update(issues).set({ lastRunId: 999 }).where(eq(issues.id, row.id)).run()
    }
    await reconcile(s.options)
    expect(s.db.select().from(issues).get()?.status).toBe('failed')
    expect(s.calls[1]!.options!.input).toContain('执行未完成（缺少任务目录）')
    if (kind === '无目录') expect(s.db.select().from(runs).get()?.error).toBe('缺少任务目录')
  } finally {
    await s.dispose()
  }
})

test.each(['有报告', '无报告'])(
  '终态先事务落库再同步标签与兜底评论，%s 正文符合模板且 GitHub 失败不回滚',
  async (kind) => {
    const s = await scenario()
    try {
      const { dir } = await s.running()
      if (kind === '有报告')
        await writeFile(
          join(dir, 'report.md'),
          Array.from({ length: 22 }, (_, i) => `line ${i + 1}`).join('\n'),
        )
      await reconcile({
        ...s.options,
        executor: fakeExecutor(),
        command: async (args, options) => {
          expect(s.db.select().from(issues).get()?.status).toBe('failed')
          expect(s.db.select().from(runs).get()).toMatchObject({
            endedAt: clock,
            error: '进程丢失',
          })
          s.calls.push({ args, options })
          throw new Error('API failed')
        },
      })
      expect(s.calls.map((call) => call.args)).toEqual([
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
          'workling:failed',
        ],
        ['gh', 'issue', 'comment', '42', '-R', 'a/b', '--body-file', '-'],
      ])
      for (const call of s.calls)
        expect(call.options?.env).toMatchObject({
          GH_TOKEN: 'repo-secret',
          GH_HOST: 'github.com',
          GH_PROMPT_DISABLED: '1',
        })
      const report =
        kind === '有报告'
          ? Array.from({ length: 20 }, (_, i) => `> line ${i + 1}`).join('\n') + '\n\n'
          : ''
      expect(s.calls[1]!.options!.input).toBe(
        `workling：执行未完成（进程丢失）。\n\n- 机器：worker\n- 耗时：2 分钟\n- 任务目录：${dir}\n\n${report}重新打上 workling:ready，或评论 \`/workling <补充说明>\` 即可重试。`,
      )
      expect(s.logs.filter((line) => line.includes('更新 GitHub 失败'))).toHaveLength(2)
      expect(s.db.select().from(issues).get()?.status).toBe('failed')
    } finally {
      await s.dispose()
    }
  },
)

test('清理按名称倒序保留 5 个，仅删除已结束 run 且保护运行目录与未登记目录', async () => {
  const s = await scenario()
  try {
    const { issue, dir } = await s.running()
    const names: string[] = []
    for (let i = 1; i <= 8; i++) {
      const name = `a-b-42-202611${String(i).padStart(2, '0')}T103000Z`
      names.push(name)
      const taskDir = join(s.workspace, 'tasks', name)
      await mkdir(taskDir)
      if (i !== 3)
        s.db
          .insert(runs)
          .values({
            issueId: issue.id,
            worker: 'worker',
            taskDir,
            startedAt: clock,
            endedAt: i === 2 ? null : clock,
          })
          .run()
    }
    await writeResult(dir, { exitCode: 1, signal: null, finishedAt: clock.toISOString() })
    await reconcile(s.options)
    const remaining = await readdir(join(s.workspace, 'tasks'))
    expect(remaining).not.toContain(names[0]!)
    expect(remaining).toContain(names[1]!)
    expect(remaining).toContain(names[2]!)
    expect(remaining.filter((name) => name >= names[4]!)).toHaveLength(5)
  } finally {
    await s.dispose()
  }
})

test('done 删除 repo 前校验任务目录，拒绝删除工作区外路径', async () => {
  const s = await scenario()
  const outside = await mkdtemp(join(tmpdir(), 'workling-outside-'))
  try {
    await s.running({ taskDir: outside })
    await mkdir(join(outside, 'repo'))
    await writeResult(outside, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
    await reconcile(s.options)
    expect(await readdir(outside)).toContain('repo')
    expect(s.logs.some((line) => line.includes('任务目录无效'))).toBe(true)
  } finally {
    await s.dispose()
    await rm(outside, { recursive: true, force: true })
  }
})

test.each([undefined, '超时', '已取消'])(
  '容器 OOM 无结果时记录内存不足，已有原因优先：%s',
  async (error) => {
    const s = await scenario()
    try {
      await s.running({ pid: null, container: 'workling-run-1', error })
      let finished = false
      await reconcile({
        ...s.options,
        executor: fakeExecutor({
          async status(run) {
            expect(run).toMatchObject({ pid: null, container: 'workling-run-1' })
            return { running: false, oom: true }
          },
          async finish() {
            finished = true
          },
        }),
      })
      expect(finished).toBe(true)
      expect(s.db.select().from(runs).get()).toMatchObject({
        error: error ?? '内存不足（OOM）',
        endedAt: clock,
      })
      expect(s.db.select().from(issues).get()?.status).toBe(
        error === '已取消' ? 'canceled' : 'failed',
      )
    } finally {
      await s.dispose()
    }
  },
)

test.each(['done', '非零结果', 'invalid', '丢失', 'canceled'])(
  '终态 %s 在事务提交前调用 finish，先于标签、评论与 repo 清理且只调用一次',
  async (kind) => {
    const s = await scenario()
    try {
      const { dir } = await s.running({
        pid: null,
        container: 'workling-run-1',
        error: kind === 'canceled' ? '已取消' : undefined,
      })
      await mkdir(join(dir, 'repo'))
      if (kind === 'done' || kind === '非零结果')
        await writeResult(dir, {
          exitCode: kind === 'done' ? 0 : 7,
          signal: null,
          finishedAt: clock.toISOString(),
        })
      if (kind === 'invalid') await writeFile(join(dir, 'result.json'), '{')
      let finished = 0
      const executor = fakeExecutor({
        async finish(run) {
          expect(run).toMatchObject({ taskDir: dir, container: 'workling-run-1', pid: null })
          expect(s.db.select().from(issues).get()?.status).toBe('running')
          expect(s.db.select().from(runs).get()?.endedAt).toBeNull()
          await writeFile(join(dir, 'task.log'), 'finish repo-secret')
          await writeFile(join(dir, 'report.md'), '结果：完成 repo-secret')
          await writeFile(
            join(dir, 'pi-events.jsonl'),
            JSON.stringify({
              type: 'message_end',
              message: { role: 'assistant', content: [{ type: 'text', text: '结论 repo-secret' }] },
            }),
          )
          expect(await readdir(dir)).toContain('repo')
          expect(s.calls.filter((call) => call.args[1] === 'issue')).toEqual([])
          finished++
        },
      })
      await reconcile({
        ...s.options,
        executor,
        command: async (args, options) => {
          if (args[1] === 'issue') expect(finished).toBe(1)
          return s.command(args, options)
        },
      })
      expect(finished).toBe(1)
      expect(s.db.select().from(runs).get()).toMatchObject({
        endedAt: expect.any(Date),
        logTail: 'finish ***',
        summary: '结论 ***',
        reportResult: '完成 ***',
      })
      await reconcile({ ...s.options, executor })
      expect(finished).toBe(1)
      if (kind === 'done') expect(await readdir(dir)).not.toContain('repo')
    } finally {
      await s.dispose()
    }
  },
)

test('容器无 pid 时仍执行超时 SIGTERM、下轮 SIGKILL，运行中不 finish', async () => {
  const s = await scenario()
  try {
    await s.running({ pid: null, container: 'workling-run-1' })
    const signals: string[] = []
    await reconcile({
      ...s.options,
      executor: fakeExecutor({
        async status() {
          return { running: true }
        },
        async signal(run, signal) {
          expect(run.container).toBe('workling-run-1')
          signals.push(signal)
        },
        async finish() {
          throw new Error('运行中不能 finish')
        },
      }),
    })
    await reconcile({
      ...s.options,
      executor: fakeExecutor({
        async status() {
          return { running: true }
        },
        async signal(_run, signal) {
          signals.push(signal)
        },
      }),
    })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(s.db.select().from(issues).get()?.status).toBe('running')
    expect(s.db.select().from(runs).get()?.error).toBe('超时')
  } finally {
    await s.dispose()
  }
})

test('保留次数配置为 2 时清理较旧的已结束任务目录', async () => {
  const s = await scenario()
  try {
    const { issue, dir } = await s.running()
    const names = ['a-b-42-20260101', 'a-b-42-20260201', 'a-b-42-20260301']
    for (const name of names) {
      const taskDir = join(s.workspace, 'tasks', name)
      await mkdir(taskDir)
      s.db
        .insert(runs)
        .values({ issueId: issue.id, worker: 'worker', taskDir, startedAt: clock, endedAt: clock })
        .run()
    }
    await writeResult(dir, { exitCode: 1, signal: null, finishedAt: clock.toISOString() })
    await reconcile({ ...s.options, settings: { ...s.options.settings, keepRuns: 2 } })
    const remaining = await readdir(join(s.workspace, 'tasks'))
    expect(remaining).toContain(names[2]!)
    expect(remaining).not.toContain(names[0]!)
    expect(remaining).not.toContain(names[1]!)
    expect(remaining).toHaveLength(2)
  } finally {
    await s.dispose()
  }
})
