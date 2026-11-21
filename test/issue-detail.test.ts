import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Value from 'typebox/value'
import { openDatabase } from '../src/db/index.ts'
import { feedback, issues, repos, runs, sessions, triageRecords } from '../src/db/schema.ts'
import { createApp } from '../src/web/app.ts'
import { hashToken } from '../src/web/auth.ts'
import { issueDetailSchema } from '../src/web/issue-detail.ts'

test('详情接口校验数据、按时间排序并要求登录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-detail-'))
  const { db, close } = await openDatabase(dir)
  const now = new Date()
  const app = createApp(db, {
    workspace: dir,
    status: () => ({
      reworkLimit: 3,
      worker: 'worker',
      interval: 60,
      timeout: 90,
      startedAt: now,
      lastPollAt: null,
      lastPollError: null,
    }),
  })
  try {
    db.insert(sessions)
      .values({
        id: hashToken('detail'),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60000),
      })
      .run()
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'secret',
        enabled: true,
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
        status: 'running',
        prUrl: 'https://github.com/a/b/pull/12',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    const old = db
      .insert(runs)
      .values({
        issueId: issue.id,
        worker: 'one',
        kind: 'rework',
        branch: 'feature',
        baseRef: 'main',
        startedAt: new Date(now.getTime() - 60000),
      })
      .returning()
      .get()
    const latest = db
      .insert(runs)
      .values({
        issueId: issue.id,
        worker: 'two',
        kind: 'rework',
        branch: 'feature',
        baseRef: 'main',
        startedAt: now,
      })
      .returning()
      .get()
    db.update(issues).set({ lastRunId: latest.id }).run()
    for (const run of [old, latest]) {
      db.insert(feedback)
        .values({
          repoId: repo.id,
          issueId: issue.id,
          prNumber: 12,
          source: 'review',
          externalId: String(run.id),
          authorId: '1',
          authorLogin: 'reviewer',
          trust: 'write',
          isCommand: true,
          body: 'changes',
          url: 'https://github.com/a/b',
          status: 'included',
          runId: run.id,
          createdAt: now,
          updatedAt: now,
          seenAt: now,
        })
        .run()
    }
    db.insert(triageRecords)
      .values({
        repoId: repo.id,
        number: 1,
        title: 'Issue',
        authorId: '1',
        authorLogin: 'author',
        trust: 'write',
        contentHash: 'hash',
        issueUpdatedAt: now,
        checks: '[]',
        decision: 'needs_info',
        llmDecision: 'accept',
        missing: '["details"]',
        alreadyReady: false,
        attempts: 1,
        triagedAt: now,
      })
      .run()
    const headers = { host: 'localhost', cookie: 'workling_session=detail' }
    for (const path of [`/api/issues/${issue.id}/detail`, `/api/runs/${old.id}/detail`]) {
      expect((await app.request(path, { headers: { host: 'localhost' } })).status).toBe(401)
      const response = await app.request(path, { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = await response.json()
      expect(Value.Check(issueDetailSchema, body)).toBe(true)
      expect(body.rework).toEqual({ rounds: 2, limit: 3 })
      expect(body.issue).toMatchObject({ stage: 'rework', branch: 'feature', baseRef: 'main' })
      expect(body.triage[0]).toMatchObject({
        decision: 'needs_info',
        llmDecision: 'accept',
        missing: ['details'],
      })
      expect(body.runs[0].branch).toBe('feature')
      expect(body.runs.map((run: { id: number }) => run.id)).toEqual([latest.id, old.id])
      expect(JSON.stringify(body)).not.toContain('secret')
    }
    for (const path of ['/api/issues/999/detail', '/api/runs/999/detail'])
      expect((await app.request(path, { headers })).status).toBe(404)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})
