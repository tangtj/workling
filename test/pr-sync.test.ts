import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { issues, repos } from '../src/db/schema.ts'
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
