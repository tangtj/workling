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
        return JSON.stringify([pr(2, 'MERGED', recent)])
      },
    })
    expect(s.logs).toHaveLength(1)
    expect(s.db.select().from(issues).where(eq(issues.number, 2)).get()).toMatchObject({
      prState: 'merged',
      status: 'failed',
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
    const calls: { args: string[]; input?: string }[] = []
    const command: typeof s.command = async (args, options) => {
      calls.push({ args, input: options?.input })
      if (args[0] === 'gh' && args[1] === 'pr' && args[2] === 'list')
        return JSON.stringify([pr(1, 'MERGED', recent), pr(2, 'OPEN', recent)])
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
