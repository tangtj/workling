import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos, triageRecords } from '../src/db/schema.ts'
import { reposRoutes } from '../src/web/routes/repos.ts'

test('分诊接口展示最新尝试并按最近结论统计四格，支持切换级别', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-api-'))
  const conn = await openDatabase(dir)
  try {
    const now = new Date('2026-01-01T12:00:00Z')
    const repo = conn.db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'x',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    const gitlab = conn.db
      .insert(repos)
      .values({
        ref: 'gitlab:a/b',
        platform: 'gitlab',
        host: 'gitlab.com',
        path: 'a/b',
        token: 'x',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    const app = reposRoutes({ db: conn.db, options: { workspace: dir } })
    const put = (id: number, level: string) =>
      app.request(`/api/repos/${id}/triage-level`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level }),
      })
    expect((await put(repo.id, 'shadow')).status).toBe(200)
    expect((await put(repo.id, 'auto')).status).toBe(400)
    expect((await put(gitlab.id, 'shadow')).status).toBe(400)
    for (const number of [1, 3, 5])
      conn.db
        .insert(issues)
        .values({
          repoId: repo.id,
          number,
          status: 'queued',
          createdAt: new Date(now.getTime() + 31 * 60000),
          updatedAt: now,
        })
        .run()
    const insert = (
      number: number,
      decision: 'accept' | 'needs_info' | null,
      hash: string,
      minutes: number,
      alreadyReady = false,
    ) =>
      conn.db
        .insert(triageRecords)
        .values({
          repoId: repo.id,
          number,
          title: 'task',
          authorId: '1',
          authorLogin: 'user',
          trust: 'write',
          contentHash: hash,
          issueUpdatedAt: now,
          checks: JSON.stringify({ missingSections: [], invalidDirectives: [] }),
          missing: '[]',
          decision,
          llmDecision: decision,
          alreadyReady,
          attempts: 1,
          triagedAt: new Date(now.getTime() + minutes * 60000),
        })
        .run()
    insert(1, 'accept', 'a', 1)
    insert(2, 'accept', 'a', 1)
    insert(3, 'needs_info', 'a', 1)
    insert(4, 'needs_info', 'a', 1)
    insert(5, 'accept', 'a', 1, true)
    insert(1, null, 'b', 2)
    const response = await app.request(`/api/repos/${repo.id}/triage`)
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.level).toBe('shadow')
    expect(data.summary).toEqual({
      total: 4,
      acceptReady: 1,
      acceptNotReady: 1,
      otherReady: 1,
      otherNotReady: 1,
    })
    expect(data.records).toHaveLength(5)
    expect(data.records.find((row: { number: number }) => row.number === 1)).toMatchObject({
      decision: null,
      readyAfterMinutes: 31,
    })
    expect(data.records.find((row: { number: number }) => row.number === 5)).toMatchObject({
      readyAfterMinutes: null,
    })
    expect((await put(repo.id, 'off')).status).toBe(200)
  } finally {
    conn.close()
    await rm(dir, { recursive: true, force: true })
  }
})
