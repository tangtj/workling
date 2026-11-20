import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos, sessions } from '../src/db/schema.ts'
import { createApp } from '../src/web/app.ts'
import { hashToken } from '../src/web/auth.ts'

test('受信账号接口校验输入、仓库与重复账号并返回反馈', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-api-'))
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
    const gitlab = db
      .insert(repos)
      .values({
        ref: 'gitlab:a/b',
        platform: 'gitlab',
        host: 'gitlab.com',
        path: 'a/b',
        token: 'token',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    const issue = db
      .insert(issues)
      .values({ repoId: repo.id, number: 1, status: 'done', createdAt: now, updatedAt: now })
      .returning()
      .get()
    db.insert(sessions)
      .values({ id: hashToken('session'), createdAt: now, expiresAt: new Date(Date.now() + 60000) })
      .run()
    const calls: string[] = []
    const app = createApp(db, {
      workspace: dir,
      command: async (args) => {
        calls.push(args[2]!)
        if (args[2] === 'users/missing') throw new Error('HTTP 404')
        return JSON.stringify({
          id: args[2] === 'users/alice' ? 1 : calls.length,
          login: args[2]!.slice(6),
        })
      },
    })
    const request = (path: string, method = 'GET', body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          host: 'localhost',
          cookie: 'workling_session=session',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    for (const user of ['alice', '@bob', 'https://github.com/carol'])
      expect((await request(`/api/repos/${repo.id}/trusted-users`, 'POST', { user })).status).toBe(
        201,
      )
    expect(
      (await request(`/api/repos/${repo.id}/trusted-users`, 'POST', { user: 'alice' })).status,
    ).toBe(409)
    const before = calls.length
    expect(
      (
        await request(`/api/repos/${repo.id}/trusted-users`, 'POST', {
          user: 'https://evil.example/alice',
        })
      ).status,
    ).toBe(400)
    expect(
      (await request(`/api/repos/${repo.id}/trusted-users`, 'POST', { user: 'bad/name' })).status,
    ).toBe(400)
    expect(calls).toHaveLength(before)
    expect(
      await (
        await request(`/api/repos/${repo.id}/trusted-users`, 'POST', { user: 'missing' })
      ).json(),
    ).toEqual({ error: '用户不存在' })
    expect(
      (await request(`/api/repos/${gitlab.id}/trusted-users`, 'POST', { user: 'alice' })).status,
    ).toBe(400)
    const list = await request(`/api/repos/${repo.id}/trusted-users`)
    expect(list.headers.get('cache-control')).toBe('no-store')
    const users = await list.json()
    expect(users.map((user: { login: string }) => user.login)).toEqual(['alice', 'bob', 'carol'])
    expect(
      (await request(`/api/repos/${repo.id}/trusted-users/${users[0].userId}`, 'DELETE')).status,
    ).toBe(204)
    expect(await (await request(`/api/issues/${issue.id}/feedback`)).json()).toEqual([])
    expect(
      (await app.request(`/api/issues/${issue.id}/feedback`, { headers: { host: 'localhost' } }))
        .status,
    ).toBe(401)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})
