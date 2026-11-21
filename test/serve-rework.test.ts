import { describe, expect, test } from 'bun:test'
import { matchCommandPrefix } from '../src/serve/feedback.ts'

describe('feedback command prefixes', () => {
  test('accepts workling and the token account at the start', () => {
    expect(matchCommandPrefix(' /workling update', 'agent')).toBe('update')
    expect(matchCommandPrefix('@agent update', 'agent')).toBe('update')
    expect(matchCommandPrefix('@other update', 'agent')).toBeNull()
  })
})

import { eq, sql } from 'drizzle-orm'
import { feedback, issues, runs } from '../src/db/schema.ts'
import { queueRework, selectBatch } from '../src/serve/rework.ts'
import { clock, scenario } from './helpers/serve.ts'
import { launchQueued } from '../src/serve/launch.ts'
import { recoverOrphanFeedback } from '../src/serve/reconcile.ts'
import { run as ignoreOldFeedback } from '../src/upgrade/steps/v0.3.0-01-ignore-observed-feedback.ts'
import { readResult } from '../src/contract/result.ts'
import { fakeExecutor } from './helpers/serve.ts'
import { localRemote } from './helpers/git.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSpec } from '../src/contract/spec.ts'
import { writeOutResult } from '../src/contract/out.ts'
import { writeResult } from '../src/contract/result.ts'
import { reconcile } from '../src/serve/reconcile.ts'

test('只选择运行后当前 PR 或 Issue 的待观察反馈，并且入队一次', async () => {
  const s = await scenario()
  try {
    const issue = await s.issue(42, 'done')
    const run = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'worker', startedAt: clock })
      .returning()
      .get()
    s.db
      .update(issues)
      .set({ lastRunId: run.id, prState: 'open', prUrl: 'https://github.com/a/b/pull/9' })
      .where(eq(issues.id, issue.id))
      .run()
    const later = new Date(clock.getTime() + 10000)
    for (const [id, status, prNumber, createdAt] of [
      ['1', 'observed', 9, later],
      ['2', 'observed', null, later],
      ['3', 'observed', 8, later],
      ['4', 'observed', 9, clock],
      ['5', 'ignored', 9, later],
      ['6', 'pending', 9, later],
      ['7', 'included', 9, later],
    ] as const) {
      s.db
        .insert(feedback)
        .values({
          repoId: issue.repoId,
          issueId: issue.id,
          prNumber,
          source: 'review',
          externalId: id,
          authorId: '1',
          authorLogin: 'alice',
          trust: 'write',
          isCommand: true,
          body: 'fix',
          url: `https://example.com/${id}`,
          status,
          createdAt,
          updatedAt: createdAt,
          seenAt: later,
        })
        .run()
    }
    const current = s.db.select().from(issues).where(eq(issues.id, issue.id)).get()!
    expect(
      selectBatch({ issue: current, run }, s.db.select().from(feedback).all()).map(
        (row) => row.externalId,
      ),
    ).toEqual(['1', '2'])
    await queueRework({
      db: s.db,
      command: s.options.command,
      log: () => {},
      signal: new AbortController().signal,
    })
    expect(s.db.select().from(issues).where(eq(issues.id, issue.id)).get()?.status).toBe('queued')
    expect(
      s.db
        .select()
        .from(feedback)
        .all()
        .map((row) => row.status),
    ).toEqual(['pending', 'pending', 'observed', 'observed', 'ignored', 'pending', 'included'])
    expect(s.calls.filter(({ args }) => args.includes('--add-label'))).toHaveLength(1)
    await queueRework({
      db: s.db,
      command: s.options.command,
      log: () => {},
      signal: new AbortController().signal,
    })
    expect(s.calls.filter(({ args }) => args.includes('--add-label'))).toHaveLength(1)
  } finally {
    await s.dispose()
  }
})

test('排队期间的新反馈被认领，拉起失败恢复触发反馈和附带评论的状态', async () => {
  const s = await scenario()
  try {
    const issue = await s.issue(42, 'queued')
    const prior = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'old', startedAt: clock })
      .returning()
      .get()
    s.db
      .update(issues)
      .set({ lastRunId: prior.id, prUrl: 'https://github.com/a/b/pull/9' })
      .where(eq(issues.id, issue.id))
      .run()
    const date = new Date(clock.getTime() + 1000)
    for (const [externalId, source, status, reviewId] of [
      ['1', 'review', 'pending', null],
      ['2', 'review_comment', 'ignored', '1'],
      ['3', 'issue_comment', 'observed', null],
    ] as const) {
      s.db
        .insert(feedback)
        .values({
          repoId: issue.repoId,
          issueId: issue.id,
          prNumber: source === 'issue_comment' ? null : 9,
          source,
          externalId,
          reviewId,
          authorId: '1',
          authorLogin: 'alice',
          trust: 'write',
          isCommand: true,
          body: 'fix',
          url: 'https://example.com',
          status,
          createdAt: date,
          updatedAt: date,
          seenAt: date,
        })
        .run()
    }
    await launchQueued({
      ...s.options,
      command: async (args) => {
        if (args[2]?.endsWith('/parent')) throw new Error('HTTP 404')
        const rows = s.db.select().from(feedback).all()
        expect(rows.map((row) => row.status)).toEqual(['included', 'included', 'included'])
        expect(new Set(rows.map((row) => row.runId)).size).toBe(1)
        throw new Error('failed')
      },
    })
    expect(
      s.db
        .select()
        .from(feedback)
        .all()
        .map((row) => [row.status, row.runId]),
    ).toEqual([
      ['pending', null],
      ['ignored', null],
      ['pending', null],
    ])
  } finally {
    await s.dispose()
  }
})

test('运行中和已排队的 Issue 不重复入队，结束后运行期间的反馈形成下一批', async () => {
  const s = await scenario()
  try {
    const issue = await s.issue(42, 'running')
    const run = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'worker', startedAt: clock })
      .returning()
      .get()
    s.db
      .update(issues)
      .set({ lastRunId: run.id, prState: 'open', prUrl: 'https://github.com/a/b/pull/9' })
      .where(eq(issues.id, issue.id))
      .run()
    const date = new Date(clock.getTime() + 1000)
    s.db
      .insert(feedback)
      .values({
        repoId: issue.repoId,
        issueId: issue.id,
        source: 'issue_comment',
        externalId: 'new',
        authorId: '1',
        authorLogin: 'alice',
        trust: 'write',
        isCommand: true,
        body: 'next',
        url: 'https://example.com/new',
        status: 'observed',
        createdAt: date,
        updatedAt: date,
        seenAt: date,
      })
      .run()
    for (const status of ['running', 'queued'] as const) {
      s.db.update(issues).set({ status }).where(eq(issues.id, issue.id)).run()
      await queueRework(s.options)
      expect(s.db.select().from(feedback).get()?.status).toBe('observed')
      expect(s.calls.filter(({ args }) => args.includes('--add-label'))).toHaveLength(0)
    }
    s.db.update(issues).set({ status: 'done' }).where(eq(issues.id, issue.id)).run()
    await queueRework(s.options)
    expect(s.db.select().from(issues).get()?.status).toBe('queued')
    expect(s.db.select().from(feedback).get()?.status).toBe('pending')
  } finally {
    await s.dispose()
  }
})

test('入队时状态已被抢占则放弃整批且不修改标签', async () => {
  const s = await scenario()
  try {
    const issue = await s.issue(42, 'done')
    const run = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'worker', startedAt: clock })
      .returning()
      .get()
    s.db.update(issues).set({ lastRunId: run.id }).where(eq(issues.id, issue.id)).run()
    const date = new Date(clock.getTime() + 1000)
    s.db
      .insert(feedback)
      .values({
        repoId: issue.repoId,
        issueId: issue.id,
        source: 'issue_comment',
        externalId: '1',
        authorId: '1',
        authorLogin: 'alice',
        trust: 'write',
        isCommand: true,
        body: 'fix',
        url: 'https://example.com/1',
        status: 'observed',
        createdAt: date,
        updatedAt: date,
        seenAt: date,
      })
      .run()
    s.db.run(
      sql.raw(
        "CREATE TRIGGER simulate_claim BEFORE UPDATE OF status ON issues WHEN NEW.status = 'queued' BEGIN UPDATE issues SET status = 'running' WHERE id = OLD.id; SELECT RAISE(IGNORE); END",
      ),
    )
    await queueRework(s.options)
    expect(s.db.select().from(issues).get()?.status).toBe('running')
    expect(s.db.select().from(feedback).get()?.status).toBe('observed')
    expect(s.calls).toHaveLength(0)
  } finally {
    await s.dispose()
  }
})

test('启动恢复孤儿运行的反馈，升级步骤只忽略旧观察记录且可重复', async () => {
  const s = await scenario()
  try {
    const issue = await s.issue(42, 'queued')
    const run = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'old', startedAt: clock })
      .returning()
      .get()
    for (const [externalId, status, runId] of [
      ['1', 'included', run.id],
      ['2', 'observed', null],
    ] as const)
      s.db
        .insert(feedback)
        .values({
          repoId: issue.repoId,
          issueId: issue.id,
          source: 'issue_comment',
          externalId,
          authorId: '1',
          authorLogin: 'alice',
          trust: 'write',
          isCommand: true,
          body: 'fix',
          url: 'https://example.com',
          status,
          runId,
          createdAt: clock,
          updatedAt: clock,
          seenAt: clock,
        })
        .run()
    recoverOrphanFeedback(s.db)
    await ignoreOldFeedback({ db: s.db, workspace: s.workspace, log: () => {} })
    await ignoreOldFeedback({ db: s.db, workspace: s.workspace, log: () => {} })
    expect(
      s.db
        .select()
        .from(feedback)
        .all()
        .map((row) => [row.status, row.runId]),
    ).toEqual([
      ['pending', null],
      ['ignored', null],
    ])
  } finally {
    await s.dispose()
  }
})

test.each([
  ['open', 'PR 分支「workling/42-issue」不存在，无法返工'],
  ['closed', 'PR 已合入或关闭，不再返工；新需求请另开 Issue'],
] as const)('反馈拉起时 PR 为 %s 且无法接续，记录失败并且不新建分支', async (prState, error) => {
  const s = await scenario()
  try {
    const issue = await s.issue(42, 'queued')
    const prior = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'old', startedAt: clock, branch: 'workling/42-issue' })
      .returning()
      .get()
    s.db.update(issues).set({ lastRunId: prior.id, prState }).where(eq(issues.id, issue.id)).run()
    s.db
      .insert(feedback)
      .values({
        repoId: issue.repoId,
        issueId: issue.id,
        source: 'issue_comment',
        externalId: '1',
        authorId: '1',
        authorLogin: 'alice',
        trust: 'write',
        isCommand: true,
        body: 'fix',
        url: 'https://example.com',
        status: 'pending',
        createdAt: clock,
        updatedAt: clock,
        seenAt: clock,
      })
      .run()
    await launchQueued({
      ...s.options,
      executor: fakeExecutor({
        async start() {
          throw new Error('不应启动')
        },
      }),
    })
    const run = s.db.select().from(runs).all().at(-1)!
    expect(await readResult(run.taskDir!)).toMatchObject({ error })
    expect(run.branch).toBeNull()
    expect(s.db.select().from(issues).get()?.status).toBe('running')
    await reconcile({ ...s.options, executor: fakeExecutor() })
    expect(s.db.select().from(issues).get()?.status).toBe('failed')
    expect(
      s.calls.some(({ args, options }) => args[2] === 'comment' && options?.input?.includes(error)),
    ).toBe(true)
  } finally {
    await s.dispose()
  }
})

test('真实 Git：review 入队后在原 PR 分支接续并快进推送，不创建 PR', async () => {
  const s = await scenario()
  try {
    const remote = await localRemote(s.workspace)
    const base = await remote.commit('refs/heads/main', 'base')
    const branch = 'workling/42-issue'
    const priorTip = await remote.commit(`refs/heads/${branch}`, 'previous', base)
    const issue = await s.issue(42, 'done')
    const prior = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'old', startedAt: clock, branch })
      .returning()
      .get()
    s.db
      .update(issues)
      .set({ lastRunId: prior.id, prState: 'open', prUrl: 'https://github.com/a/b/pull/9' })
      .where(eq(issues.id, issue.id))
      .run()
    const date = new Date(clock.getTime() + 1000)
    const review = s.db
      .insert(feedback)
      .values({
        repoId: issue.repoId,
        issueId: issue.id,
        prNumber: 9,
        source: 'review',
        externalId: '12',
        authorId: '1',
        authorLogin: 'alice',
        trust: 'write',
        isCommand: true,
        reviewState: 'CHANGES_REQUESTED',
        body: 'fix this',
        url: 'https://example.com/review/12',
        status: 'observed',
        createdAt: date,
        updatedAt: date,
        seenAt: date,
      })
      .returning()
      .get()
    await queueRework(s.options)
    expect(s.db.select().from(issues).get()?.status).toBe('queued')
    for (let i = 0; i < 10; i++)
      s.db
        .insert(feedback)
        .values({
          repoId: issue.repoId,
          issueId: issue.id,
          source: 'issue_comment',
          externalId: `extra-${i}`,
          authorId: '1',
          authorLogin: 'alice',
          trust: 'write',
          isCommand: true,
          body: 'more',
          url: `https://example.com/extra/${i}`,
          status: 'observed',
          createdAt: date,
          updatedAt: date,
          seenAt: date,
        })
        .run()
    let tip = ''
    const command: typeof s.command = (args, options) =>
      args[0] === 'git' ? remote.git(args, options) : s.command(args, options)
    await launchQueued({
      ...s.options,
      command,
      now: () => new Date(clock.getTime() + 2000),
      executor: fakeExecutor({
        async start({ taskDir }) {
          const spec = await readSpec(taskDir)
          expect(spec.kind).toBe('rework')
          expect(spec.repo).toMatchObject({ branch, baseRef: priorTip, continued: true })
          expect(await readFile(join(taskDir, 'input/feedback.md'), 'utf8')).toContain('fix this')
          const cwd = join(taskDir, 'repo')
          await writeFile(join(cwd, 'content.txt'), 'reworked')
          await remote.git(['git', 'add', 'content.txt'], { cwd })
          await remote.git(['git', 'commit', '-m', 'Address review'], { cwd })
          tip = await remote.git(['git', 'rev-parse', 'HEAD'], { cwd })
          const out = join(taskDir, 'out')
          await mkdir(out, { recursive: true })
          await remote.git(
            [
              'git',
              'bundle',
              'create',
              join(out, 'commits.bundle'),
              `${priorTip}..refs/heads/${branch}`,
            ],
            { cwd },
          )
          await writeOutResult(out, {
            contract: 2,
            outcome: 'completed',
            branch,
            head: tip,
            commits: 1,
          })
          await writeFile(join(out, 'pr-body.md'), 'Updated')
          await writeFile(
            join(out, 'replies.json'),
            JSON.stringify([
              { feedbackId: review.id, body: '已改：content.txt 改为 reworked' },
              { feedbackId: 9999, body: '不属于本次运行' },
            ]),
          )
          await writeResult(taskDir, {
            exitCode: 0,
            signal: null,
            finishedAt: new Date(clock.getTime() + 3000).toISOString(),
          })
          return { pid: 123 }
        },
      }),
    })
    const run = s.db.select().from(runs).all().at(-1)!
    expect(run.kind).toBe('rework')
    expect(
      s.db
        .select()
        .from(feedback)
        .all()
        .every((row) => row.status === 'included' && row.runId === run.id),
    ).toBe(true)
    const claim = s.calls.find(({ args }) => args[1] === 'issue' && args[2] === 'comment')?.options
      ?.input
    expect(claim).toContain('收到 PR 反馈，开始返工')
    expect(claim).toContain('https://example.com/review/12')
    expect(claim).toContain('等 11 条')
    await reconcile({ ...s.options, command, executor: fakeExecutor() })
    expect(s.db.select().from(issues).get()?.status).toBe('done')
    expect(await remote.write(['rev-parse', `refs/heads/${branch}`])).toBe(tip)
    expect(await remote.write(['merge-base', '--is-ancestor', priorTip, tip])).toBe('')
    expect(s.calls.filter(({ args }) => args[1] === 'pr' && args[2] === 'create')).toHaveLength(0)
    const prReply = s.calls.find(
      ({ args, options }) =>
        args[1] === 'pr' && args[2] === 'comment' && options?.input?.includes('反馈处理说明'),
    )?.options?.input
    expect(prReply).toContain(`F${review.id} · Review（CHANGES_REQUESTED）`)
    expect(prReply).toContain('已改：content.txt 改为 reworked')
    expect(prReply).not.toContain('不属于本次运行')
    const issueReply = s.calls.find(
      ({ args, options }) =>
        args[1] === 'issue' && args[2] === 'comment' && options?.input?.includes('反馈处理说明'),
    )?.options?.input
    expect(issueReply).toContain('本轮未单独说明')
    expect(
      s.db
        .select()
        .from(feedback)
        .all()
        .every((row) => row.status === 'replied'),
    ).toBe(true)
  } finally {
    await s.dispose()
  }
})
