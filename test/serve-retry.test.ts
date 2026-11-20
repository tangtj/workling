import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos, runs } from '../src/db/schema.ts'
import { matchCommandPrefix, retryOnCommand, type RetryState } from '../src/serve/retry.ts'
import type { Command } from '../src/runtime/types.ts'

test('指令评论只重试符合条件的失败任务，并按 token 缓存账号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-'))
  const { db, close } = await openDatabase(dir)
  try {
    const old = new Date('2025-01-01T00:00:00Z')
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'one',
        createdAt: old,
        updatedAt: old,
      })
      .returning()
      .get()
    for (let n = 1; n <= 9; n++) {
      const issue = db
        .insert(issues)
        .values({
          repoId: repo.id,
          number: n,
          status: n === 8 ? 'done' : 'failed',
          createdAt: old,
          updatedAt: old,
        })
        .returning()
        .get()
      const run = db
        .insert(runs)
        .values({ issueId: issue.id, worker: 'w', startedAt: old })
        .returning()
        .get()
      db.update(issues).set({ lastRunId: run.id }).where(eq(issues.id, issue.id)).run()
    }
    const bodies = [
      '/workling go',
      '  @OWNER go',
      '/workling old',
      '/workling wrong',
      'text /workling',
      '/workling2',
      '@owner2',
      '/workling done',
      '/workling once',
    ]
    const comments = bodies.map((body, i) => ({
      id: i + 1,
      issue_url: `https://api.github.com/repos/a/b/issues/${i + 1}`,
      user: { login: i === 3 ? 'other' : 'Owner' },
      body,
      created_at: i === 2 ? '2024-01-01T00:00:00Z' : '2025-01-02T00:00:00Z',
      html_url: `https://github.com/a/b/issues/${i + 1}#issuecomment-${i + 1}`,
    }))
    const calls: string[][] = []
    const command: Command = async (args) => {
      calls.push(args)
      if (args[2] === 'user') return 'owner\n'
      if (args[1] === 'api') return JSON.stringify([comments])
      return ''
    }
    const state: RetryState = { accounts: new Map(), triggers: new Map() }
    const logs: string[] = []
    const retry = () =>
      retryOnCommand({
        db,
        command,
        state,
        log: (s) => logs.push(s),
        signal: new AbortController().signal,
      })
    await retry()
    expect(
      db
        .select()
        .from(issues)
        .orderBy(issues.number)
        .all()
        .map((i) => i.status),
    ).toEqual([
      'queued',
      'queued',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'done',
      'queued',
    ])
    expect(calls.filter((a) => a[2] === 'edit').map((a) => a[3])).toEqual(['1', '2', '9'])
    expect(calls.find((a) => a[2] === 'edit')).toContain('workling:failed')
    expect(state.triggers.size).toBe(3)
    const ninth = db.select().from(issues).where(eq(issues.number, 9)).get()!
    db.update(runs)
      .set({ startedAt: new Date('2025-01-03T00:00:00Z') })
      .where(eq(runs.id, ninth.lastRunId!))
      .run()
    db.update(issues).set({ status: 'failed' }).where(eq(issues.id, ninth.id)).run()
    await retry()
    expect(db.select().from(issues).where(eq(issues.id, ninth.id)).get()!.status).toBe('failed')
    expect(calls.filter((a) => a[2] === 'user')).toHaveLength(1)
    db.update(repos).set({ token: 'two' }).where(eq(repos.id, repo.id)).run()
    await retry()
    expect(calls.filter((a) => a[2] === 'user')).toHaveLength(2)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('无失败任务不访问 GitHub，账号或评论数据错误不阻塞其他仓库', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-errors-'))
  const { db, close } = await openDatabase(dir)
  try {
    const now = new Date('2025-01-01T00:00:00Z')
    for (const name of ['empty', 'baduser', 'badcomments', 'good']) {
      const repo = db
        .insert(repos)
        .values({
          ref: `github:a/${name}`,
          platform: 'github',
          host: 'github.com',
          path: `a/${name}`,
          token: name,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get()
      if (name === 'empty') continue
      const issue = db
        .insert(issues)
        .values({ repoId: repo.id, number: 1, status: 'failed', createdAt: now, updatedAt: now })
        .returning()
        .get()
      const run = db
        .insert(runs)
        .values({ issueId: issue.id, worker: 'w', startedAt: now })
        .returning()
        .get()
      db.update(issues).set({ lastRunId: run.id }).where(eq(issues.id, issue.id)).run()
    }
    const calls: string[] = []
    const logs: string[] = []
    const command: Command = async (args, options) => {
      const token = options?.env?.GH_TOKEN ?? ''
      calls.push(token)
      if (args[2] === 'user') {
        if (token === 'baduser') throw new Error('denied')
        return 'owner'
      }
      if (args[1] === 'api')
        return token === 'badcomments'
          ? '[{}]'
          : JSON.stringify([
              [
                {
                  id: 1,
                  issue_url: 'https://api.github.com/repos/a/good/issues/1',
                  user: { login: 'owner' },
                  body: '/workling',
                  created_at: '2025-01-02T00:00:00Z',
                  html_url: 'https://example/comment',
                },
              ],
            ])
      return ''
    }
    await retryOnCommand({
      db,
      command,
      log: (s) => logs.push(s),
      signal: new AbortController().signal,
    })
    expect(calls).not.toContain('empty')
    expect(logs.some((s) => s.includes('baduser') && s.includes('denied'))).toBe(true)
    expect(logs.some((s) => s.includes('badcomments') && s.includes('格式无效'))).toBe(true)
    expect(
      db
        .select()
        .from(issues)
        .all()
        .map((i) => i.status),
    ).toEqual(['failed', 'failed', 'queued'])
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('指令前缀支持空白和大小写并拒绝错误位置或名称', () => {
  expect(matchCommandPrefix('  /WORKLING\tfix ', 'worker')).toBe('fix')
  expect(matchCommandPrefix(' @Worker fix', 'worker')).toBe('fix')
  expect(matchCommandPrefix('/worklingx fix', 'worker')).toBeNull()
  expect(matchCommandPrefix('hello /workling fix', 'worker')).toBeNull()
  expect(matchCommandPrefix('/workling', 'worker')).toBe('')
})
