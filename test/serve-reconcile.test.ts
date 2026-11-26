import { AI_NOTICE } from '../src/serve/comment.ts'
import { eq } from 'drizzle-orm'
import { processExecutor } from '../src/executor/process.ts'
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOutResult } from '../src/contract/out.ts'
import { writeLlmSecrets } from '../src/contract/secrets.ts'
import { issues, repos, reviews, runs } from '../src/db/schema.ts'
import { writeResult } from '../src/contract/result.ts'
import { reconcile } from '../src/serve/reconcile.ts'
import { mirrorPath } from '../src/serve/mirror.ts'
import { localRemote } from './helpers/git.ts'
import { fakeExecutor, clock, scenario } from './helpers/serve.ts'

test('对账退出码 0 落地成功后标记 done，保存链接与结果时间并安全删除 repo', async () => {
  const s = await scenario()
  try {
    const { dir } = await s.running({ delivery: true })
    await mkdir(join(dir, 'repo'))
    await writeFile(join(dir, 'report.md'), '保留')
    await writeFile(join(dir, 'out', 'outcome.json'), '{"outcome":"completed","executor":"pi"}')
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
      executor: 'pi',
      error: null,
    })
    expect((await readdir(dir)).sort()).toEqual(['out', 'report.md', 'result.json'])
    expect(s.calls.map((call) => call.args)).toEqual([
      [
        'gh',
        'pr',
        'list',
        '-R',
        'a/b',
        '--head',
        'workling/42-issue',
        '--state',
        'open',
        '--json',
        'url,state,isDraft',
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
      ['gh', 'issue', 'comment', '42', '-R', 'a/b', '--body-file', '-'],
    ])
    expect(s.calls.at(-1)?.options?.input).toBe(
      `### ✅ 第 1 轮 · 实现 · 完成\n\n[PR #1](https://github.com/a/b/pull/1) · 更新 · 1 个提交 · 用时 1 分钟 · Pi 实现 · 运行 #1\n\n**下一步**：评审并合并 PR。需要修改时在 PR 或本 Issue 评论 \`/workling <说明>\`。\n\n\n${AI_NOTICE}\n\n<!-- workling -->`,
    )
  } finally {
    await s.dispose()
  }
})

test.each(['off', 'shadow'] as const)(
  '部分完成的返工按 %s 级别决定是否排评审',
  async (reviewLevel) => {
    const s = await scenario()
    try {
      s.db.update(repos).set({ reviewLevel }).run()
      const { issue, dir, run } = await s.running({ delivery: true })
      s.db.update(runs).set({ kind: 'rework' }).where(eq(runs.id, run.id)).run()
      await writeOutResult(join(dir, 'out'), {
        contract: 2,
        outcome: 'partial',
        branch: run.branch!,
        head: 'b'.repeat(40),
        commits: 1,
      })
      await writeResult(dir, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
      await reconcile(s.options)
      expect(s.db.select().from(issues).get()?.status).toBe('done')
      const rows = s.db.select().from(reviews).all()
      if (reviewLevel === 'off') expect(rows).toEqual([])
      else
        expect(rows).toMatchObject([
          {
            issueId: issue.id,
            deliveryRunId: run.id,
            status: 'queued',
            partial: true,
            headSha: 'b'.repeat(40),
          },
        ])
    } finally {
      await s.dispose()
    }
  },
)

test('对账完成自动变基交付后同时记录新基点与 Issue 终态', async () => {
  const s = await scenario()
  try {
    const { dir, run } = await s.running({ delivery: true })
    s.db.update(repos).set({ reviewLevel: 'shadow' }).run()
    const remote = await localRemote(s.workspace)
    const initial = await remote.commit('refs/heads/main', 'initial')
    const upstream = 'workling/12-upstream'
    const upstreamRef = `refs/heads/${upstream}`
    const upstreamStart = await remote.commit(upstreamRef, 'upstream step one', initial)
    const baseRef = await remote.commit(upstreamRef, 'upstream change', upstreamStart)
    const ref = `refs/heads/${run.branch!}`
    const tip = await remote.commit(ref, 'downstream change', baseRef)
    const mirror = mirrorPath(s.workspace, s.repo)
    await mkdir(join(mirror, '..'), { recursive: true })
    await remote.git(['git', 'clone', '--bare', remote.path, mirror], { quietStderr: true })
    const out = join(dir, 'out')
    await remote.write(['bundle', 'create', join(out, 'commits.bundle'), `${baseRef}..${ref}`])
    await writeOutResult(out, {
      contract: 2,
      outcome: 'completed',
      branch: run.branch!,
      head: tip,
      commits: 1,
    })
    await remote.write(['update-ref', '-d', ref])
    const newBase = await remote.commit('refs/heads/main', 'upstream change', initial)
    await remote.write(['update-ref', '-d', upstreamRef])
    s.db.update(runs).set({ baseRef, stackBranch: upstream }).where(eq(runs.id, run.id)).run()
    await writeResult(dir, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
    const prUrl = 'https://github.com/a/b/pull/1'
    let prBase: string | undefined
    const options: Parameters<typeof reconcile>[0] = {
      ...s.options,
      command: (args, options) => {
        if (args[0] === 'git') return remote.git(args, options)
        if (args[1] === 'pr' && args[2] === 'list')
          return Promise.resolve(args.includes('merged') ? '[{"number":12}]' : '[]')
        if (args[1] === 'pr' && args[2] === 'create') {
          prBase = args[args.indexOf('--base') + 1]
          return Promise.resolve(prUrl)
        }
        if (args.includes('workling:done')) {
          expect(s.db.select().from(issues).get()).toMatchObject({ status: 'done', prUrl })
          expect(s.db.select().from(reviews).get()?.status).toBe('queued')
          expect(s.db.select().from(runs).get()).toMatchObject({
            stackBranch: null,
            baseRef: newBase,
          })
        }
        return s.command(args, options)
      },
    }
    await reconcile(options)
    expect(prBase).toBe('main')
    expect(await remote.write(['rev-parse', `${ref}^`])).toBe(newBase)
    expect(s.db.select().from(issues).get()).toMatchObject({ status: 'done', prUrl })
    expect(s.db.select().from(runs).get()).toMatchObject({ stackBranch: null, baseRef: newBase })
    const headSha = await remote.write(['rev-parse', ref])
    expect(headSha).not.toBe(tip)
    expect(s.db.select().from(reviews).get()).toMatchObject({
      deliveryRunId: run.id,
      status: 'queued',
      headSha,
      partial: false,
      prUrl,
      branch: run.branch,
    })
    // 用同一次交付的原始运行数据重试，远端已经有变基后的提交和 PR。
    s.db.update(runs).set({ baseRef, stackBranch: upstream }).where(eq(runs.id, run.id)).run()
    s.db.update(issues).set({ status: 'running' }).run()
    await reconcile({
      ...options,
      command: (args, opts) =>
        args[1] === 'pr' && args[2] === 'list' && !args.includes('merged')
          ? Promise.resolve(JSON.stringify([{ url: prUrl, state: 'OPEN', isDraft: false }]))
          : options.command(args, opts),
    })
    expect(s.db.select().from(reviews).all()).toHaveLength(1)
    expect(s.db.select().from(issues).get()?.status).toBe('done')
  } finally {
    await s.dispose()
  }
})

test('交付持续抛错超过 30 分钟后对账标记失败并发出脱敏评论', async () => {
  const s = await scenario()
  try {
    const { dir } = await s.running({ delivery: true })
    await writeResult(dir, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
    let attempts = 0
    let now = clock
    const options: Parameters<typeof reconcile>[0] = {
      ...s.options,
      now: () => now,
      command: (args, opts) => {
        if (args[1] === 'pr' && args[2] === 'list') {
          attempts++
          throw new Error('GitHub 拒绝请求 repo-secret')
        }
        return s.command(args, opts)
      },
    }
    for (const minutes of [0, 29, 30]) {
      now = new Date(clock.getTime() + minutes * 60_000)
      await reconcile(options)
      expect(s.db.select().from(issues).get()?.status).toBe('running')
      expect(s.db.select().from(runs).get()?.endedAt).toBeNull()
      expect(s.calls).toEqual([])
    }
    now = new Date(clock.getTime() + 31 * 60_000)
    await reconcile(options)
    expect(s.db.select().from(issues).get()?.status).toBe('failed')
    expect(s.db.select().from(runs).get()).toMatchObject({
      endedAt: now,
      exitCode: 0,
      error: 'GitHub 拒绝请求 ***',
    })
    expect(s.calls).toHaveLength(2)
    expect(s.calls[0]?.args).toContain('workling:failed')
    expect(s.calls[1]?.options?.input).toStartWith(
      '### ❌ 第 1 轮 · 实现 · 对账失败，已停止重试\n\n用时 33 分钟 · 运行 #1\n\n**原因**：GitHub 拒绝请求 ***',
    )
    expect(s.calls[1]?.options?.input).toContain(
      '**下一步**：重新打上 `workling:ready`，或评论 `/workling <补充说明>` 重试。',
    )
    expect(s.logs.join('\n')).not.toContain('repo-secret')
    await reconcile(options)
    expect(attempts).toBe(4)
    expect(s.calls).toHaveLength(2)
  } finally {
    await s.dispose()
  }
})

test.each([0, 1])('答复模式有 %i 个提交时只标记 done 并发布答复', async (commits) => {
  const s = await scenario()
  try {
    s.db.update(repos).set({ reviewLevel: 'shadow' }).run()
    const { issue, dir, run } = await s.running({ delivery: true })
    const prUrl = 'https://github.com/a/b/pull/9'
    s.db.update(issues).set({ prUrl, prState: 'open' }).where(eq(issues.id, issue.id)).run()
    const out = join(dir, 'out')
    await rm(join(out, 'commits.bundle'))
    await writeOutResult(out, {
      contract: 2,
      outcome: 'answered',
      branch: run.branch!,
      head: null,
      commits,
    })
    if (commits)
      await writeFile(
        join(out, 'issue-comment.md'),
        '结果：完成。请 @someone 核对 repo-secret\n\n### 检查',
      )
    await writeResult(dir, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
    const commands: string[][] = []
    await reconcile({
      ...s.options,
      command: (args, options) => {
        if (!args[2]?.endsWith('/parent') && !(args[2] === 'view' && args.at(-1) === 'labels'))
          commands.push(args)
        return s.command(args, options)
      },
    })
    expect(s.db.select().from(issues).get()).toMatchObject({
      status: 'done',
      prUrl,
      prState: 'open',
    })
    expect(s.db.select().from(runs).get()?.error).toBeNull()
    expect(s.db.select().from(reviews).all()).toEqual([])
    expect(commands).toEqual([
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
      ['gh', 'issue', 'comment', '42', '-R', 'a/b', '--body-file', '-'],
    ])
    expect(s.calls.at(-1)?.options?.input).toBe(
      `### 💬 第 1 轮 · 答复\n\n用时 2 分钟 · 运行 #1\n\n${commits ? '请 <code>&#64;someone</code> 核对 ***\n\n**检查**' : '（Pi 未写说明）'}\n\n**下一步**：还有问题或需要改代码时评论 \`/workling <说明>\`。\n\n\n${AI_NOTICE}\n\n<!-- workling -->`,
    )
    expect(s.logs.some((line) => line.includes('答复模式下存在提交，已忽略'))).toBe(commits > 0)
  } finally {
    await s.dispose()
  }
})

test('对账退出码 0 但旧运行缺少分支记录时判失败', async () => {
  const s = await scenario()
  try {
    const { dir } = await s.running()
    await writeResult(dir, { exitCode: 0, signal: null, finishedAt: 'invalid date' })
    await reconcile(s.options)
    expect(s.db.select().from(issues).get()?.status).toBe('failed')
    expect(s.db.select().from(runs).get()).toMatchObject({
      error: '缺少分支记录',
      endedAt: clock,
      exitCode: 0,
    })
    expect(s.calls.some(({ args }) => args[1] === 'pr')).toBe(false)
  } finally {
    await s.dispose()
  }
})

test.each([
  ['全部成功', ['读取', '结果评论', '重读', '编辑']],
  ['结果评论', ['读取', '结果评论']],
  ['读取', ['读取', '结果评论']],
  ['重读', ['读取', '结果评论', '重读']],
  ['编辑', ['读取', '结果评论', '重读', '编辑']],
  ['无变更', ['读取', '结果评论']],
  ['仅取消勾选', ['读取', '结果评论', '重读', '编辑']],
] as const)('落地后的 Issue 同步：%s，保持 done 且下轮不重发', async (failure, expected) => {
  const s = await scenario()
  try {
    const { dir } = await s.running({ delivery: true })
    await writeFile(join(dir, 'out', 'issue-comment.md'), '检查通过 @someone')
    await writeFile(
      join(dir, 'out', 'checklist.json'),
      JSON.stringify([
        { line: '- [ ] Run tests', checked: true, evidence: 'bun run check\n  @reviewer' },
        { line: '* [x] Old', checked: false, evidence: '命令退出 1' },
        { line: '- [ ] Missing', checked: true, evidence: 'checked' },
        { line: '- [ ] Duplicate', checked: true, evidence: 'checked' },
      ]),
    )
    await writeResult(dir, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
    const steps: string[] = []
    const messages: string[] = []
    let edited: string | undefined
    const options = {
      ...s.options,
      command: (async (args, options) => {
        if (args[2] === 'view' && args.at(-1) === 'labels') return s.command(args, options)
        if (
          args[0] !== 'gh' ||
          args[1] !== 'issue' ||
          (!args.includes('--body-file') && args[2] !== 'view')
        )
          return s.command(args, options)
        const step =
          args[2] === 'view'
            ? steps.includes('读取')
              ? '重读'
              : '读取'
            : args[2] === 'edit'
              ? '编辑'
              : '结果评论'
        steps.push(step)
        if (step === failure) throw new Error('API failed')
        if (step === '读取')
          return JSON.stringify({
            body:
              failure === '无变更'
                ? '- [x] Run tests'
                : failure === '仅取消勾选'
                  ? '* [x] Old'
                  : '- [ ] Run tests \r\n* [x] Old\r\n- [ ] Duplicate\r\n- [ ] Duplicate',
          })
        if (step === '重读')
          return JSON.stringify({
            body:
              failure === '仅取消勾选'
                ? '* [x] Old'
                : '新标题\r\n- [ ] Run tests \r\n* [x] Renamed\r\n',
          })
        if (step === '编辑') {
          edited = options?.input
          expect(edited).not.toContain(AI_NOTICE)
        } else messages.push(options?.input ?? '')
        return ''
      }) satisfies typeof s.command,
    }
    await reconcile(options)
    await reconcile(options)
    expect(s.db.select().from(issues).get()?.status).toBe('done')
    expect(steps).toEqual([...expected])
    expect(messages).toHaveLength(failure === '结果评论' ? 0 : 1)
    if (failure === '全部成功') {
      expect(messages[0]).toContain(
        '**验收勾选**：勾选 1 项，取消 1 项，跳过 2 项\n\n<details><summary>逐项依据</summary>\n\n' +
          '- ☑ Run tests\n  - 依据：bun run check <code>&#64;reviewer</code>\n' +
          '- ☐ Old（取消勾选）\n  - 依据：命令退出 1\n' +
          '- 跳过：Missing（找不到原文行）\n- 跳过：Duplicate（匹配多行）\n\n</details>\n\n**下一步**',
      )
      expect(edited).toBe('新标题\r\n- [x] Run tests \r\n* [x] Renamed\r\n')
    } else if (failure === '仅取消勾选') {
      expect(messages[0]).toContain('**验收勾选**：取消 1 项，跳过 3 项')
      expect(edited).toBe('* [ ] Old')
    } else if (failure === '读取' || failure === '无变更') {
      expect(messages[0]).toStartWith('### ✅')
      expect(messages[0]).not.toContain('**验收勾选**')
      if (failure === '读取') expect(s.logs).toContain('a/b #42 读取 Issue 正文失败')
    } else if (failure === '结果评论') {
      expect(s.logs).toContain('a/b #42 发送 Issue 评论失败')
      expect(edited).toBeUndefined()
    }
  } finally {
    await s.dispose()
  }
})

test.each(['命令失败', 'JSON 无效', '形状无效'])(
  'PR 查询%s 本轮跳过且下一轮可完成',
  async (kind) => {
    const s = await scenario()
    try {
      const { dir } = await s.running({ delivery: true })
      await writeResult(dir, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
      await reconcile({
        ...s.options,
        command: async (args, options) => {
          if (args[0] === 'git') return s.command(args, options)
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

test.each(['无 run', 'run 不存在', '无目录'])(
  '缺少任务目录时标记失败并根据运行记录生成标题和事实行：%s',
  async (kind) => {
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
      const header =
        kind === '无目录'
          ? '### ❌ 第 1 轮 · 实现 · 未完成\n\n用时 2 分钟 · 运行 #1'
          : '### ❌ 执行未完成'
      expect(s.calls[1]!.options!.input).toBe(
        `${header}\n\n**原因**：缺少任务目录\n\n` +
          '**下一步**：重新打上 `workling:ready`，或评论 `/workling <补充说明>` 重试。' +
          `\n\n\n${AI_NOTICE}\n\n<!-- workling -->`,
      )
      if (kind === '无目录') expect(s.db.select().from(runs).get()?.error).toBe('缺少任务目录')
    } finally {
      await s.dispose()
    }
  },
)

test.each(['有报告', '无报告', '有报告和 Pi 说明'])(
  '终态先事务落库再同步标签与兜底评论，%s 正文符合模板且 GitHub 失败不回滚',
  async (kind) => {
    const s = await scenario()
    try {
      const { dir } = await s.running()
      if (kind !== '无报告')
        await writeFile(
          join(dir, 'report.md'),
          Array.from({ length: 22 }, (_, i) => `line ${i + 1}`).join('\n'),
        )
      if (kind === '有报告和 Pi 说明') {
        await mkdir(join(dir, 'out'))
        await writeFile(
          join(dir, 'out', 'issue-comment.md'),
          '未找到错误前的步骤。\n\n### 检查\n\n@someone 检查未通过',
        )
      }
      await reconcile({
        ...s.options,
        executor: fakeExecutor(),
        command: async (args, options) => {
          expect(s.db.select().from(issues).get()?.status).toBe('failed')
          expect(s.db.select().from(runs).get()).toMatchObject({
            endedAt: clock,
            error: '进程丢失',
          })
          if (args[2]?.endsWith('/parent')) throw new Error('HTTP 404')
          if (args[2] === 'view' && args.at(-1) === 'labels')
            return JSON.stringify({ labels: [{ name: 'workling:running' }] })
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
        kind !== '无报告'
          ? '\n\n<details><summary>回报摘录</summary>\n\n' +
            Array.from({ length: 22 }, (_, i) => `> line ${i + 1}`).join('\n') +
            '\n\n</details>'
          : ''
      const explanation =
        kind === '有报告和 Pi 说明'
          ? '\n\n未找到错误前的步骤。\n\n**检查**\n\n<code>&#64;someone</code> 检查未通过'
          : ''
      expect(s.calls[1]!.options!.input).toBe(
        `### ❌ 第 1 轮 · 实现 · 未完成\n\n用时 2 分钟 · 运行 #1\n\n**原因**：进程丢失${explanation}${report}\n\n` +
          '**下一步**：重新打上 `workling:ready`，或评论 `/workling <补充说明>` 重试。' +
          `\n\n\n${AI_NOTICE}\n\n<!-- workling -->`,
      )
      expect(s.logs.filter((line) => line.includes('更新 GitHub 失败'))).toHaveLength(2)
      expect(s.db.select().from(issues).get()?.status).toBe('failed')
    } finally {
      await s.dispose()
    }
  },
)

test('长报告的失败评论引用未完成与存疑小节', async () => {
  const s = await scenario()
  try {
    const { dir } = await s.running()
    await writeFile(
      join(dir, 'report.md'),
      [
        ...Array.from({ length: 45 }, (_, i) => `第 ${i + 1} 行`),
        '## 未完成与存疑',
        '复查部署日志 repo-secret',
        '## 其他',
        '不引用此节',
      ].join('\n'),
    )
    await writeResult(dir, { exitCode: 1, signal: null, finishedAt: clock.toISOString() })
    await reconcile({ ...s.options, executor: fakeExecutor() })
    const comment = s.calls.find(({ args }) => args[2] === 'comment')?.options?.input
    expect(comment).toContain('> 第 15 行\n> …\n> ## 未完成与存疑\n> 复查部署日志 ***')
    expect(comment).not.toContain('第 16 行')
    expect(comment).not.toContain('不引用此节')
  } finally {
    await s.dispose()
  }
})

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
    await s.running({ taskDir: outside, delivery: true })
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
        delivery: kind === 'done',
      })
      await mkdir(join(dir, 'repo'))
      await writeLlmSecrets(dir, {
        baseUrl: 'https://llm.example/v1',
        apiKey: 'fake-key',
        api: 'openai-responses',
      })
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
          await mkdir(join(dir, 'out'), { recursive: true })
          await writeFile(
            join(dir, 'out', 'outcome.json'),
            JSON.stringify({
              outcome: 'completed',
              executor: 'mixed',
              assessment: {
                difficulty: 'high',
                clarity: 'unclear',
                reason: '涉及迁移 repo-secret',
              },
            }),
          )
          await writeFile(
            join(dir, 'pi-events.jsonl'),
            JSON.stringify({
              type: 'message_end',
              message: { role: 'assistant', content: [{ type: 'text', text: '结论 repo-secret' }] },
            }),
          )
          expect(await readdir(dir)).toContain('repo')
          expect(await readdir(dir)).toContain('secrets')
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
      expect(await readdir(dir)).not.toContain('secrets')
      expect(s.db.select().from(runs).get()).toMatchObject({
        endedAt: expect.any(Date),
        logTail: 'finish ***',
        summary: '结论 ***',
        reportResult: '完成 ***',
        executor: 'mixed',
        difficulty: 'high',
        clarity: 'unclear',
        assessmentNote: '涉及迁移 ***',
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

test.each(['done', 'failed'] as const)('执行结束为 %s 时移除其他已有状态标签', async (status) => {
  const s = await scenario()
  try {
    const { dir } = await s.running({ delivery: status === 'done' })
    await writeResult(dir, {
      exitCode: status === 'done' ? 0 : 1,
      signal: null,
      finishedAt: clock.toISOString(),
    })
    const edits: string[][] = []
    await reconcile({
      ...s.options,
      command: async (args, options) => {
        if (args[2] === 'view' && args.at(-1) === 'labels')
          return JSON.stringify({
            labels: ['queued', 'running', status === 'done' ? 'failed' : 'done'].map((name) => ({
              name: `workling:${name}`,
            })),
          })
        if (args[2] === 'edit' && args.includes('--add-label')) edits.push(args)
        return s.command(args, options)
      },
    })
    expect(edits).toHaveLength(1)
    expect(edits[0]).toContain(`workling:${status}`)
    expect(edits[0]).toContain('workling:queued')
    expect(edits[0]).toContain('workling:running')
    expect(edits[0]).toContain(`workling:${status === 'done' ? 'failed' : 'done'}`)
  } finally {
    await s.dispose()
  }
})
