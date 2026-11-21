import { expect, test } from 'bun:test'
import { classifyCommand } from '../src/serve/feedback.ts'
import { observeFeedback } from '../src/serve/feedback.ts'
import { openDatabase } from '../src/db/index.ts'
import { feedback, feedbackCursors, issues, repos, runs, trustedUsers } from '../src/db/schema.ts'
import { queueRework } from '../src/serve/rework.ts'
import { eq } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('只把可信作者开头的前缀或请求修改 review 视为指令', () => {
  expect(classifyCommand(' /workling fix', 'write', 'worker', null)).toEqual({
    isCommand: true,
    instruction: 'fix',
  })
  expect(classifyCommand('@Worker fix', 'allowlist', 'worker', null)).toEqual({
    isCommand: true,
    instruction: 'fix',
  })
  expect(classifyCommand('/workling\tfix', 'write', 'worker', null)).toEqual({
    isCommand: true,
    instruction: 'fix',
  })
  expect(classifyCommand('@other fix', 'write', 'worker', null).isCommand).toBe(false)
  expect(classifyCommand('fix', 'write', 'worker', 'COMMENTED').isCommand).toBe(false)
  expect(classifyCommand('/workling fix', 'write', 'worker', 'COMMENTED').isCommand).toBe(true)
  expect(classifyCommand('/worklingmore', 'write', 'worker', null).isCommand).toBe(false)
  expect(classifyCommand('hello /workling fix', 'write', 'worker', null).isCommand).toBe(false)
  expect(classifyCommand('/workling fix', 'untrusted', 'worker', null).isCommand).toBe(false)
  expect(classifyCommand('fix', 'write', 'worker', 'CHANGES_REQUESTED')).toEqual({
    isCommand: true,
    instruction: 'fix',
  })
})

test('首次建立游标，之后去重、重新判定编辑并缓存写权限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'observe-feedback-'))
  const { db, close } = await openDatabase(dir)
  try {
    const now = new Date()
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'token',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    db.insert(issues)
      .values({ repoId: repo.id, number: 1, status: 'done', createdAt: now, updatedAt: now })
      .run()
    const state = { accounts: new Map(), permissions: new Map() }
    const calls: string[] = []
    let body = 'hello'
    let updated = '2026-01-02T00:00:00Z'
    const command = async (args: string[]) => {
      const endpoint = args[2] ?? ''
      calls.push(endpoint)
      if (endpoint === 'user') return 'worker'
      if (endpoint.includes('/permission')) return JSON.stringify({ permission: 'write' })
      if (endpoint.includes('issues/comments'))
        return JSON.stringify([
          [
            {
              id: 1,
              user: { id: 5, login: 'alice', type: 'User' },
              body,
              html_url: 'https://example.com/1',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: updated,
              issue_url: 'https://api.github.com/repos/a/b/issues/1',
            },
          ],
        ])
      return '[[]]'
    }
    const options = {
      db,
      command,
      log: (message: string) => {
        throw new Error(message)
      },
      signal: new AbortController().signal,
      state,
    }
    await observeFeedback(options)
    expect(calls).toEqual([])
    db.update(feedbackCursors)
      .set({
        cursor: new Date('2025-12-31T00:00:00Z'),
        startedAt: new Date('2025-12-31T00:00:00Z'),
      })
      .run()
    await observeFeedback(options)
    expect(
      db
        .select()
        .from(feedback)
        .all()
        .map((row) => [row.trust, row.status]),
    ).toEqual([['write', 'ignored']])
    body = '/workling fix'
    updated = '2026-01-03T00:00:00Z'
    await observeFeedback(options)
    await observeFeedback(options)
    expect(
      db
        .select()
        .from(feedback)
        .all()
        .map((row) => [row.status, row.instruction]),
    ).toEqual([['observed', 'fix']])
    expect(calls.filter((call) => call.includes('/permission'))).toHaveLength(1)
    expect(calls.some((call) => call.includes('since=2025-12-30T23:55:00.000Z'))).toBe(true)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-cases-'))
  const { db, close } = await openDatabase(dir)
  const now = new Date('2025-01-01T00:00:00Z')
  const repo = db
    .insert(repos)
    .values({
      ref: 'github:a/b',
      platform: 'github',
      host: 'github.com',
      path: 'a/b',
      token: 'token',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  const issue = db
    .insert(issues)
    .values({
      repoId: repo.id,
      number: 1,
      status: 'done',
      prUrl: 'https://github.com/a/b/pull/7',
      prState: 'open',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  const calls: string[] = []
  const logs: string[] = []
  let respond: (endpoint: string) => string = () => '[[]]'
  const options = {
    db,
    state: { accounts: new Map(), permissions: new Map() },
    signal: new AbortController().signal,
    log: (s: string) => logs.push(s),
    command: async (args: string[]) => {
      const endpoint = args[2] ?? ''
      calls.push(endpoint)
      return respond(endpoint)
    },
  }
  await observeFeedback(options)
  db.update(feedbackCursors).set({ cursor: now, startedAt: now }).run()
  return {
    db,
    repo,
    issue,
    calls,
    logs,
    options,
    setRespond: (fn: typeof respond) => {
      respond = fn
    },
    cleanup: async () => {
      close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function comment(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    user: { id, login: `user${id}`, type: 'Bot' },
    body: 'hello',
    html_url: `https://example.com/${id}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

test('观察到的写权限指令入队，而未受信、机器人和自身评论不入队', async () => {
  const f = await fixture()
  try {
    const prior = f.db
      .insert(runs)
      .values({ issueId: f.issue.id, worker: 'old', startedAt: new Date('2025-01-01T00:00:00Z') })
      .returning()
      .get()
    f.db.update(issues).set({ lastRunId: prior.id }).where(eq(issues.id, f.issue.id)).run()
    const users = [
      { id: 1, login: 'writer', type: 'User' },
      { id: 2, login: 'reader', type: 'User' },
      { id: 3, login: 'robot', type: 'Bot' },
      { id: 4, login: 'worker', type: 'User' },
    ]
    f.setRespond((endpoint) => {
      if (endpoint === 'user') return 'worker'
      if (endpoint.includes('/permission'))
        return endpoint.includes('/writer/') ? '{"permission":"write"}' : '{"permission":"read"}'
      if (endpoint.includes('issues/comments'))
        return JSON.stringify([
          users.map((user) =>
            comment(user.id, {
              user,
              body: user.login === 'worker' ? '<!-- workling --> /workling fix' : '/workling fix',
              issue_url: 'https://api.github.com/repos/a/b/issues/1',
            }),
          ),
        ])
      return '[[]]'
    })
    await observeFeedback(f.options)
    await queueRework(f.options)
    expect(f.db.select().from(issues).get()?.status).toBe('queued')
    expect(
      f.db
        .select()
        .from(feedback)
        .all()
        .map((row) => [row.trust, row.status]),
    ).toEqual([
      ['write', 'pending'],
      ['untrusted', 'ignored'],
      ['bot', 'ignored'],
      ['self', 'ignored'],
    ])
  } finally {
    await f.cleanup()
  }
})

test('按编号区分 Issue 评论和 PR 对话区评论并丢弃未知编号', async () => {
  const f = await fixture()
  try {
    f.setRespond((endpoint) =>
      endpoint.includes('issues/comments')
        ? JSON.stringify([
            [1, 7, 99].map((n) =>
              comment(n, { issue_url: `https://api.github.com/repos/a/b/issues/${n}` }),
            ),
          ])
        : '[[]]',
    )
    await observeFeedback(f.options)
    expect(
      f.db
        .select()
        .from(feedback)
        .all()
        .map((r) => [r.source, r.prNumber, r.issueId]),
    ).toEqual([
      ['issue_comment', null, f.issue.id],
      ['pr_comment', 7, f.issue.id],
    ])
  } finally {
    await f.cleanup()
  }
})

test('行内评论记录路径和行号并忽略其他 PR', async () => {
  const f = await fixture()
  try {
    f.setRespond((endpoint) =>
      endpoint.includes('pulls/comments')
        ? JSON.stringify([
            [
              comment(1, {
                pull_request_url: 'https://api.github.com/repos/a/b/pulls/7',
                path: 'a.ts',
                line: 12,
              }),
              comment(2, {
                pull_request_url: 'https://api.github.com/repos/a/b/pulls/7',
                path: 'b.ts',
                line: null,
                original_line: 9,
              }),
              comment(3, { pull_request_url: 'https://api.github.com/repos/a/b/pulls/8' }),
            ],
          ])
        : '[[]]',
    )
    await observeFeedback(f.options)
    expect(
      f.db
        .select()
        .from(feedback)
        .all()
        .map((r) => [r.source, r.prNumber, r.path, r.line]),
    ).toEqual([
      ['review_comment', 7, 'a.ts', 12],
      ['review_comment', 7, 'b.ts', 9],
    ])
  } finally {
    await f.cleanup()
  }
})

test('仅请求开放 PR 的 review 并跳过待提交和游标之前的 review', async () => {
  const f = await fixture()
  try {
    f.db
      .insert(issues)
      .values({
        repoId: f.repo.id,
        number: 2,
        status: 'done',
        prUrl: 'https://github.com/a/b/pull/8',
        prState: 'closed',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run()
    f.setRespond((endpoint) => {
      if (endpoint === 'user') return 'worker'
      if (endpoint.includes('/permission')) return '{"permission":"write"}'
      if (endpoint.includes('/pulls/7/reviews'))
        return JSON.stringify([
          [
            comment(1, { state: 'PENDING', submitted_at: null }),
            comment(2, { state: 'COMMENTED', submitted_at: '2024-01-01T00:00:00Z' }),
            comment(3, {
              user: { id: 3, login: 'alice', type: 'User' },
              body: '请修改',
              state: 'CHANGES_REQUESTED',
              submitted_at: '2026-01-01T00:00:00Z',
            }),
          ],
        ])
      return '[[]]'
    })
    await observeFeedback(f.options)
    expect(f.calls.some((c) => c.includes('/pulls/7/reviews'))).toBe(true)
    expect(f.calls.some((c) => c.includes('/pulls/8/reviews'))).toBe(false)
    expect(
      f.db
        .select()
        .from(feedback)
        .all()
        .map((r) => [r.source, r.isCommand, r.status, r.reviewState]),
    ).toEqual([['review', true, 'observed', 'CHANGES_REQUESTED']])
  } finally {
    await f.cleanup()
  }
})

test('接口返回错误形状时记录错误且不推进游标', async () => {
  const f = await fixture()
  try {
    const before = f.db
      .select()
      .from(feedbackCursors)
      .all()
      .map((c) => c.cursor.getTime())
    f.setRespond((endpoint) => (endpoint.includes('pulls/comments') ? '{}' : '[[]]'))
    await observeFeedback(f.options)
    expect(f.logs.some((s) => s.includes('观察反馈失败'))).toBe(true)
    expect(
      f.db
        .select()
        .from(feedbackCursors)
        .all()
        .map((c) => c.cursor.getTime()),
    ).toEqual(before)
  } finally {
    await f.cleanup()
  }
})

test('按自身、机器人、允许名单和权限判断信任并缓存权限及处理 404', async () => {
  const f = await fixture()
  try {
    f.db
      .insert(trustedUsers)
      .values({ repoId: f.repo.id, userId: '3', login: 'user3', createdAt: new Date() })
      .run()
    const items = [
      comment(1, { body: '<!-- workling -->', user: { id: 1, login: 'user1', type: 'User' } }),
      comment(2),
      comment(3, { user: { id: 3, login: 'user3', type: 'User' } }),
      ...[4, 5].map((id) => comment(id, { user: { id: 4, login: 'writer', type: 'User' } })),
      comment(6, { user: { id: 6, login: 'missing', type: 'User' } }),
      comment(7, { user: { id: 7, login: 'reader', type: 'User' } }),
    ].map((item) => ({ ...item, issue_url: 'https://api.github.com/repos/a/b/issues/1' }))
    f.setRespond((endpoint) => {
      if (endpoint === 'user') return 'worker'
      if (endpoint.includes('/writer/permission')) return '{"permission":"write"}'
      if (endpoint.includes('/missing/permission'))
        throw new Error('gh 退出码 1\nHTTP/2.0 404 Not Found\n...')
      if (endpoint.includes('/reader/permission')) return '{"permission":"read"}'
      if (endpoint.includes('issues/comments')) return JSON.stringify([items])
      return '[[]]'
    })
    await observeFeedback(f.options)
    expect(
      f.db
        .select()
        .from(feedback)
        .all()
        .map((r) => r.trust),
    ).toEqual(['self', 'bot', 'allowlist', 'write', 'write', 'untrusted', 'untrusted'])
    expect(f.calls.filter((c) => c.includes('/permission'))).toHaveLength(3)
    expect(f.logs).toEqual([])
    expect(
      f.db
        .select()
        .from(feedbackCursors)
        .all()
        .every((c) => c.cursor > new Date('2025-01-01T00:00:00Z')),
    ).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test('已进入处理状态的反馈在编辑后保持原记录', async () => {
  const f = await fixture()
  try {
    let body = '原文'
    let updated = '2026-01-01T00:00:00Z'
    f.setRespond((endpoint) =>
      endpoint.includes('issues/comments')
        ? JSON.stringify([
            [
              comment(1, {
                body,
                updated_at: updated,
                issue_url: 'https://api.github.com/repos/a/b/issues/1',
              }),
            ],
          ])
        : '[[]]',
    )
    await observeFeedback(f.options)
    f.db.update(feedback).set({ status: 'pending' }).run()
    body = '/workling 修改'
    updated = '2026-01-02T00:00:00Z'
    await observeFeedback(f.options)
    const row = f.db.select().from(feedback).get()!
    expect([row.body, row.status, row.isCommand]).toEqual(['原文', 'pending', false])
  } finally {
    await f.cleanup()
  }
})
