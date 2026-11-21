import { describe, expect, test } from 'bun:test'
import { matchCommandPrefix } from '../src/serve/feedback.ts'

describe('feedback command prefixes', () => {
  test('accepts workling and the token account at the start', () => {
    expect(matchCommandPrefix(' /workling update', 'agent')).toBe('update')
    expect(matchCommandPrefix('@agent update', 'agent')).toBe('update')
    expect(matchCommandPrefix('@other update', 'agent')).toBeNull()
  })
})

import { eq } from 'drizzle-orm'
import { feedback, issues, runs } from '../src/db/schema.ts'
import { queueRework, selectBatch } from '../src/serve/rework.ts'
import { clock, scenario } from './helpers/serve.ts'

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
