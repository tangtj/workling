import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Value from 'typebox/value'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos, runs, sessions } from '../src/db/schema.ts'
import { createApp } from '../src/web/app.ts'
import { hashToken } from '../src/web/auth.ts'
import { issueDetailSchema } from '../src/web/issue-detail.ts'

test('详情接口校验数据、按时间排序并要求登录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-detail-'))
  const { db, close } = await openDatabase(dir)
  const now = new Date()
  const app = createApp(db, { workspace: dir })
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
      .values({ repoId: repo.id, number: 1, status: 'running', createdAt: now, updatedAt: now })
      .returning()
      .get()
    const old = db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'one', startedAt: new Date(now.getTime() - 60000) })
      .returning()
      .get()
    const latest = db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'two', startedAt: now })
      .returning()
      .get()
    const headers = { host: 'localhost', cookie: 'workling_session=detail' }
    for (const path of [`/api/issues/${issue.id}/detail`, `/api/runs/${old.id}/detail`]) {
      expect((await app.request(path, { headers: { host: 'localhost' } })).status).toBe(401)
      const response = await app.request(path, { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = await response.json()
      expect(Value.Check(issueDetailSchema, body)).toBe(true)
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
