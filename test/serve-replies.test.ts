import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readReplies } from '../src/contract/out.ts'
import { feedback, issues, runs } from '../src/db/schema.ts'
import { publishReplies } from '../src/serve/replies.ts'
import { countAutoRounds, queueRework } from '../src/serve/rework.ts'
import type { Command } from '../src/runtime/types.ts'
import { clock, scenario } from './helpers/serve.ts'

type Scenario = Awaited<ReturnType<typeof scenario>>
type FeedbackInput = Partial<typeof feedback.$inferInsert> & { externalId: string }

function addFeedback(s: Scenario, issueId: number, repoId: number, values: FeedbackInput) {
  const date = values.createdAt ?? new Date(clock.getTime() + 1000)
  return s.db
    .insert(feedback)
    .values({
      repoId,
      issueId,
      source: 'review',
      authorId: '1',
      authorLogin: 'alice',
      trust: 'write',
      isCommand: true,
      body: 'fix',
      url: `https://example.com/${values.externalId}`,
      status: 'observed',
      createdAt: date,
      updatedAt: date,
      seenAt: date,
      ...values,
    })
    .returning()
    .get()
}

async function outDir(replies?: unknown) {
  const taskDir = await mkdtemp(join(tmpdir(), 'workling-replies-'))
  await mkdir(join(taskDir, 'out'))
  if (replies !== undefined)
    await writeFile(join(taskDir, 'out/replies.json'), JSON.stringify(replies))
  return taskDir
}

test('readReplies 缺文件返回空，无效 JSON 或结构报错', async () => {
  expect(await readReplies(join(await outDir(), 'out'))).toEqual([])
  expect(await readReplies(join(await outDir([{ feedbackId: 3, body: 'ok' }]), 'out'))).toEqual([
    { feedbackId: 3, body: 'ok' },
  ])
  await expect(
    readReplies(join(await outDir([{ feedbackId: 0, body: 'x' }]), 'out')),
  ).rejects.toThrow('结构无效')
  const broken = await outDir()
  await writeFile(join(broken, 'out/replies.json'), '{')
  await expect(readReplies(join(broken, 'out'))).rejects.toThrow('不是有效的 JSON')
})

test('行内评论回到原线程，发送失败的保持 included', async () => {
  const s = await scenario()
  try {
    const issue = await s.issue(42, 'done')
    const run = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'w', startedAt: clock, kind: 'rework' })
      .returning()
      .get()
    const inline = addFeedback(s, issue.id, issue.repoId, {
      externalId: '555',
      source: 'review_comment',
      prNumber: 9,
      path: 'a.ts',
      line: 3,
      status: 'included',
      runId: run.id,
    })
    const comment = addFeedback(s, issue.id, issue.repoId, {
      externalId: '556',
      source: 'pr_comment',
      prNumber: 9,
      status: 'included',
      runId: run.id,
    })
    const other = addFeedback(s, issue.id, issue.repoId, {
      externalId: '557',
      source: 'pr_comment',
      prNumber: 9,
      status: 'included',
      runId: run.id + 1,
    })
    const taskDir = await outDir([
      { feedbackId: inline.id, body: '已改，见 @bob 的建议，token repo-secret' },
      { feedbackId: inline.id, body: '重复的回复' },
    ])
    const calls: { args: string[]; input?: string }[] = []
    const command: Command = async (args, options) => {
      calls.push({ args, input: options?.input })
      if (args[2] === 'comment') throw new Error('网络错误')
      return ''
    }
    const logs: string[] = []
    await publishReplies({
      db: s.db,
      repo: { host: 'github.com', path: 'a/b', token: 'repo-secret' },
      issue: { number: 42 },
      runId: run.id,
      taskDir,
      prUrl: 'https://github.com/a/b/pull/9',
      command,
      llmApiKey: null,
      log: (message) => logs.push(message),
    })
    const thread = calls.find(({ args }) => args[1] === 'api')!
    expect(thread.args).toContain('repos/a/b/pulls/9/comments/555/replies')
    const body = (JSON.parse(thread.input!) as { body: string }).body
    expect(body).toStartWith('workling：已改')
    expect(body).toContain('`@bob`')
    expect(body).not.toContain('repo-secret')
    expect(body).not.toContain('重复的回复')
    expect(body).toEndWith('<!-- workling -->')
    const statuses = Object.fromEntries(
      s.db
        .select()
        .from(feedback)
        .all()
        .map((row) => [row.id, row.status]),
    )
    expect(statuses).toEqual({
      [inline.id]: 'replied',
      [comment.id]: 'included',
      [other.id]: 'included',
    })
    expect(logs).toEqual([`a/b #42 回复反馈 F${comment.id} 失败`])
  } finally {
    await s.dispose()
  }
})

test('countAutoRounds 只统计当前 PR 上没有显式指令的返工运行', () => {
  const row = (runId: number, values: Partial<typeof feedback.$inferSelect>) =>
    ({
      runId,
      prNumber: 9,
      source: 'review',
      isCommand: true,
      status: 'replied',
      ...values,
    }) as typeof feedback.$inferSelect
  const rows = [
    row(1, {}),
    row(1, { source: 'review_comment', isCommand: false }),
    row(2, { status: 'included' }),
    row(3, { source: 'pr_comment' }),
    row(4, { prNumber: 8 }),
    row(5, {}),
    row(6, { status: 'pending' }),
  ]
  expect(countAutoRounds(9, rows, new Set([1, 2, 3, 4, 6]))).toBe(2)
})

async function capScenario(
  limit: number,
  extra: (s: Scenario, issueId: number, repoId: number) => void,
) {
  const s = await scenario()
  const issue = await s.issue(42, 'done')
  for (let i = 0; i < 3; i++) {
    const run = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'w', startedAt: clock, kind: 'rework' })
      .returning()
      .get()
    addFeedback(s, issue.id, issue.repoId, {
      externalId: `old-${i}`,
      prNumber: 9,
      reviewState: 'CHANGES_REQUESTED',
      status: 'replied',
      runId: run.id,
      createdAt: clock,
    })
  }
  const last = s.db.select().from(runs).all().at(-1)!
  s.db
    .update(issues)
    .set({ lastRunId: last.id, prState: 'open', prUrl: 'https://github.com/a/b/pull/9' })
    .where(eq(issues.id, issue.id))
    .run()
  addFeedback(s, issue.id, issue.repoId, {
    externalId: 'new',
    prNumber: 9,
    reviewState: 'CHANGES_REQUESTED',
  })
  extra(s, issue.id, issue.repoId)
  await queueRework({ ...s.options, reworkLimit: limit })
  return s
}

test('自动返工达到上限后标记 capped、不入队并在 PR 评论一次', async () => {
  const s = await capScenario(3, () => {})
  try {
    expect(s.db.select().from(issues).get()?.status).toBe('done')
    expect(s.db.select().from(feedback).all().at(-1)?.status).toBe('capped')
    const comments = s.calls.filter(({ args }) => args[1] === 'pr' && args[2] === 'comment')
    expect(comments).toHaveLength(1)
    expect(comments[0]!.options?.input).toContain('已自动返工 3 轮')
    await queueRework({ ...s.options, reworkLimit: 3 })
    expect(s.calls.filter(({ args }) => args[1] === 'pr' && args[2] === 'comment')).toHaveLength(1)
  } finally {
    await s.dispose()
  }
})

test('未到上限的自动返工和带指令的批次照常入队', async () => {
  for (const [limit, withCommand] of [
    [4, false],
    [3, true],
  ] as const) {
    const s = await capScenario(limit, (s, issueId, repoId) => {
      if (withCommand)
        addFeedback(s, issueId, repoId, {
          externalId: 'cmd',
          source: 'pr_comment',
          prNumber: 9,
          instruction: '继续',
        })
    })
    try {
      expect(s.db.select().from(issues).get()?.status).toBe('queued')
      expect(
        s.db
          .select()
          .from(feedback)
          .all()
          .filter((row) => row.status === 'pending'),
      ).toHaveLength(withCommand ? 2 : 1)
    } finally {
      await s.dispose()
    }
  }
})

test('WORKLING_REWORK_LIMIT=0 时 Request changes 不入队', async () => {
  const s = await scenario()
  try {
    const issue = await s.issue(42, 'done')
    const run = s.db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'w', startedAt: clock })
      .returning()
      .get()
    s.db
      .update(issues)
      .set({ lastRunId: run.id, prState: 'open', prUrl: 'https://github.com/a/b/pull/9' })
      .where(eq(issues.id, issue.id))
      .run()
    addFeedback(s, issue.id, issue.repoId, { externalId: 'r', prNumber: 9 })
    await queueRework({ ...s.options, reworkLimit: 0 })
    expect(s.db.select().from(issues).get()?.status).toBe('done')
    expect(s.db.select().from(feedback).get()?.status).toBe('capped')
    expect(s.calls.find(({ args }) => args[2] === 'comment')?.options?.input).toContain(
      '已关闭自动返工',
    )
  } finally {
    await s.dispose()
  }
})
