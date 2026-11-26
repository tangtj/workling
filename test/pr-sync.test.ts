import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { issues, repos, runs } from '../src/db/schema.ts'
import { syncPullRequests } from '../src/serve/pr-sync.ts'
import { clock, scenario } from './helpers/serve.ts'

const pr = (
  number: number,
  state: string,
  updatedAt: string,
  headRefName = `workling/${number}-task`,
) => ({
  number,
  url: `https://example.com/${number}/${state}/${updatedAt}`,
  headRefName,
  state,
  updatedAt,
})
const old = '2026-01-01T00:00:00Z'
const recent = '2026-02-01T00:00:00Z'

test('同步优先打开的 PR，同优先级选最新，保留执行中和未找到的记录', async () => {
  const s = await scenario()
  try {
    for (const [number, status] of [
      [1, 'failed'],
      [2, 'done'],
      [3, 'queued'],
      [4, 'running'],
      [5, 'failed'],
      [6, 'failed'],
    ] as const) {
      await s.issue(number, status)
      s.db
        .update(issues)
        .set({ prUrl: 'old', prState: 'closed' })
        .where(eq(issues.number, number))
        .run()
    }
    const signal = new AbortController().signal
    await syncPullRequests({
      db: s.db,
      signal,
      log: s.log,
      command: async (args, options) => {
        if (args[1] === 'issue') return '[]'
        expect(args).toEqual([
          'gh',
          'pr',
          'list',
          '-R',
          'a/b',
          '--state',
          'all',
          '--search',
          'head:workling/',
          '--json',
          'number,url,headRefName,state,updatedAt',
          '--limit',
          '100',
        ])
        expect(options?.signal).toBe(signal)
        return JSON.stringify([
          pr(1, 'MERGED', recent),
          pr(1, 'OPEN', old),
          pr(2, 'CLOSED', old),
          pr(2, 'MERGED', recent),
          pr(3, 'OPEN', recent),
          pr(4, 'OPEN', recent),
          pr(6, 'OPEN', recent, 'other/6-task'),
        ])
      },
    })
    const rows = s.db.select().from(issues).all()
    expect(rows.find((i) => i.number === 1)).toMatchObject({
      status: 'failed',
      prState: 'open',
      updatedAt: clock,
    })
    expect(rows.find((i) => i.number === 2)).toMatchObject({
      status: 'done',
      prState: 'merged',
      updatedAt: clock,
    })
    for (const number of [3, 4, 5, 6])
      expect(rows.find((i) => i.number === number)).toMatchObject({
        prUrl: 'old',
        prState: 'closed',
        updatedAt: clock,
      })
  } finally {
    await s.dispose()
  }
})

test.each(['命令失败', 'JSON 无效', '形状无效'])('仓库%s时继续同步下一个仓库', async (failure) => {
  const s = await scenario()
  try {
    await s.issue(1, 'failed')
    const repo = s.db
      .insert(repos)
      .values({
        ref: 'github:c/d',
        platform: 'github',
        host: 'github.com',
        path: 'c/d',
        token: 't',
        createdAt: clock,
        updatedAt: clock,
      })
      .returning()
      .get()
    await s.issue(2, 'failed', repo.id)
    await syncPullRequests({
      db: s.db,
      signal: new AbortController().signal,
      log: s.log,
      command: async (args) => {
        if (args.includes('a/b')) {
          if (failure === '命令失败') throw new Error('failed')
          return failure === 'JSON 无效' ? '{' : '[{"number": 1}]'
        }
        if (args[1] === 'issue')
          return args[2] === 'view'
            ? JSON.stringify({ labels: [{ name: 'workling:failed' }] })
            : '[]'
        return JSON.stringify([pr(2, 'MERGED', recent)])
      },
    })
    expect(s.logs.filter((line) => line.includes('PR 同步失败'))).toHaveLength(1)
    expect(s.db.select().from(issues).where(eq(issues.number, 2)).get()).toMatchObject({
      prState: 'merged',
      status: 'done',
    })
  } finally {
    await s.dispose()
  }
})

test.each(['成功', '冲突', '远端已更新', '运行中'])('上游合并后处理下游：%s', async (mode) => {
  const s = await scenario()
  try {
    const upstream = await s.issue(1, 'done')
    const downstream = await s.issue(2, mode === '运行中' ? 'running' : 'done')
    for (const issue of [upstream, downstream])
      s.db
        .update(issues)
        .set({ prState: 'open', prUrl: `https://github.com/a/b/pull/${issue.number}` })
        .where(eq(issues.id, issue.id))
        .run()
    s.db
      .insert(runs)
      .values({ issueId: upstream.id, worker: 'test', startedAt: clock, branch: 'workling/1-task' })
      .run()
    const run = s.db
      .insert(runs)
      .values({
        issueId: downstream.id,
        worker: 'test',
        startedAt: clock,
        branch: 'workling/2-task',
        baseRef: 'a'.repeat(40),
        stackBranch: 'workling/1-task',
      })
      .returning()
      .get()
    for (const issueId of [upstream.id, downstream.id])
      s.db.insert(runs).values({ issueId, kind: 'review', worker: 'test', startedAt: clock }).run()
    const calls: { args: string[]; input?: string }[] = []
    const command: typeof s.command = async (args, options) => {
      calls.push({ args, input: options?.input })
      if (args[0] === 'gh' && args[1] === 'pr' && args[2] === 'list')
        return JSON.stringify([pr(1, 'MERGED', recent), pr(2, 'OPEN', recent)])
      if (args[0] === 'gh' && args[1] === 'issue' && args[2] === 'list') return '[]'
      if (args[0] === 'gh' && args[1] === 'api') return 'main'
      if (args.includes('rev-parse'))
        return args.at(-1)?.includes('origin/main') ? 'b'.repeat(40) : 'c'.repeat(40)
      if (args.includes('rebase') && args.includes('--onto') && mode === '冲突')
        throw new Error('conflict')
      if (args.includes('--diff-filter=U')) return 'conflict.txt'
      if (args.includes('push') && mode === '远端已更新') throw new Error('lease rejected')
      return ''
    }
    const sync = () =>
      syncPullRequests({ db: s.db, workspace: s.workspace, command, signal: s.signal, log: s.log })
    await sync()
    const afterFirst = calls.length
    await sync()
    expect(calls.slice(afterFirst).map((call) => call.args.slice(0, 3))).toEqual([
      ['gh', 'pr', 'list'],
      ['gh', 'issue', 'list'],
    ])
    const push = calls.find((call) => call.args.includes('push'))
    const edit = calls.find((call) => call.args[1] === 'pr' && call.args[2] === 'edit')
    if (mode === '成功' || mode === '远端已更新')
      expect(push?.args).toContain(
        `--force-with-lease=refs/heads/workling/2-task:${'c'.repeat(40)}`,
      )
    else expect(push).toBeUndefined()
    expect(Boolean(edit)).toBe(mode === '成功')
    expect(s.db.select().from(runs).where(eq(runs.id, run.id)).get()).toMatchObject(
      mode === '成功'
        ? { stackBranch: null, baseRef: 'b'.repeat(40) }
        : { stackBranch: 'workling/1-task', baseRef: 'a'.repeat(40) },
    )
    if (mode === '冲突') {
      expect(calls.some((call) => call.args.includes('--abort'))).toBe(true)
      expect(calls.some((call) => call.input?.includes('conflict.txt'))).toBe(true)
    }
    if (mode === '运行中') expect(calls.some((call) => call.input?.includes('手动'))).toBe(true)
  } finally {
    await s.dispose()
  }
})

test('已合并 PR 修正失败和取消状态，关闭的失败 Issue 根据当前 PR 状态取消', async () => {
  const s = await scenario()
  try {
    for (const [number, status, prState] of [
      [1, 'failed', 'merged'],
      [2, 'canceled', null],
      [3, 'failed', 'closed'],
      [4, 'failed', null],
      [5, 'failed', 'open'],
      [6, 'running', null],
      [7, 'queued', null],
      [8, 'done', null],
    ] as const) {
      await s.issue(number, status)
      s.db.update(issues).set({ prState }).where(eq(issues.number, number)).run()
    }
    const edits: string[][] = []
    await syncPullRequests({
      db: s.db,
      signal: s.signal,
      log: s.log,
      command: async (args) => {
        if (args[1] === 'pr')
          return JSON.stringify([
            pr(1, 'MERGED', recent),
            pr(2, 'MERGED', recent),
            pr(3, 'CLOSED', recent),
            pr(5, 'OPEN', recent),
            pr(6, 'MERGED', recent),
            pr(7, 'MERGED', recent),
            pr(8, 'MERGED', recent),
          ])
        if (args[2] === 'list')
          return JSON.stringify([3, 4, 5].map((number) => ({ number, stateReason: 'COMPLETED' })))
        if (args[2] === 'view') return JSON.stringify({ labels: [{ name: 'workling:failed' }] })
        edits.push(args)
        return ''
      },
    })
    const rows = s.db.select().from(issues).orderBy(issues.number).all()
    expect(rows.map((row) => row.status)).toEqual([
      'done',
      'done',
      'canceled',
      'canceled',
      'failed',
      'running',
      'queued',
      'done',
    ])
    expect(edits.map((args) => args[3])).toEqual(['1', '2', '3', '4'])
    expect(edits[0]).toContain('workling:done')
    expect(edits[0]).toContain('workling:failed')
    expect(edits[2]).not.toContain('--add-label')
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThan(clock.getTime())
  } finally {
    await s.dispose()
  }
})

test('标签更新失败保留合并状态，关闭 Issue 列表无效不影响 PR 同步', async () => {
  const s = await scenario()
  try {
    await s.issue(1, 'failed')
    await syncPullRequests({
      db: s.db,
      signal: s.signal,
      log: s.log,
      command: async (args) => {
        if (args[1] === 'pr') return JSON.stringify([pr(1, 'MERGED', recent)])
        if (args[2] === 'list') return '[{"number":"bad"}]'
        if (args[2] === 'view') return JSON.stringify({ labels: [{ name: 'workling:failed' }] })
        throw new Error('edit failed')
      },
    })
    expect(s.db.select().from(issues).get()).toMatchObject({ status: 'done', prState: 'merged' })
    expect(s.logs.some((line) => line.includes('更新标签失败'))).toBe(true)
    expect(s.logs.some((line) => line.includes('已关闭 Issue 列表格式无效'))).toBe(true)
  } finally {
    await s.dispose()
  }
})

test('PR 同步只更新状态有变化且已启用进度的 Issue', async () => {
  const s = await scenario()
  try {
    for (const [number, status, prState, progressCommentId] of [
      [1, 'done', 'open', 71],
      [2, 'done', 'open', 72],
      [3, 'done', 'open', 73],
      [4, 'done', 'open', null],
      [5, 'failed', 'merged', 75],
      [6, 'failed', 'open', 76],
      [7, 'done', 'open', null],
    ] as const) {
      const row = await s.issue(number, status)
      const run = s.db
        .insert(runs)
        .values({
          issueId: row.id,
          worker: 'worker',
          startedAt: clock,
          endedAt: clock,
          outcome: number === 7 ? 'completed' : null,
        })
        .returning()
        .get()
      s.db
        .update(issues)
        .set({ prUrl: 'old', prState, progressCommentId, lastRunId: run.id })
        .where(eq(issues.id, row.id))
        .run()
    }
    const options: Parameters<typeof syncPullRequests>[0] = {
      ...s.options,
      command: async (args, opts) => {
        if (args[1] === 'pr')
          return JSON.stringify([
            pr(1, 'MERGED', recent),
            pr(2, 'CLOSED', recent),
            pr(3, 'OPEN', recent),
            pr(4, 'MERGED', recent),
            pr(5, 'MERGED', recent),
            pr(6, 'CLOSED', recent),
            pr(7, 'MERGED', recent),
          ])
        if (args[2] === 'list') return '[{"number":6,"stateReason":"COMPLETED"}]'
        return s.command(args, opts)
      },
    }
    await syncPullRequests(options)
    const comments = s.calls.filter(({ args }) => args[2] === '--method')
    expect(
      comments.map(({ args, options }) => [
        args[3],
        args[4],
        JSON.parse(options!.input!).body.split('\n')[0],
      ]),
    ).toEqual([
      ['PATCH', 'repos/a/b/issues/comments/71', '### 进度 · ✅ 已合并'],
      ['PATCH', 'repos/a/b/issues/comments/72', '### 进度 · PR 已关闭'],
      ['PATCH', 'repos/a/b/issues/comments/75', '### 进度 · ✅ 已合并'],
      ['PATCH', 'repos/a/b/issues/comments/76', '### 进度 · 已取消'],
      ['POST', 'repos/a/b/issues/7/comments', '### 进度 · ✅ 已合并'],
    ])
    expect(s.db.select().from(issues).where(eq(issues.number, 4)).get()).toMatchObject({
      prState: 'merged',
      progressCommentId: null,
    })
    expect(s.db.select().from(issues).where(eq(issues.number, 7)).get()?.progressCommentId).toBe(
      1007,
    )
    s.calls.length = 0
    await syncPullRequests(options)
    expect(s.calls).toEqual([])
  } finally {
    await s.dispose()
  }
})
