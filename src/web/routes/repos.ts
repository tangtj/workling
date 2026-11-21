import { maskToken } from '../data.ts'
import * as Type from 'typebox'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import * as Value from 'typebox/value'
import { repos, trustedUsers } from '../../db/schema.ts'
import { formatRepoRef, parseRepoRef } from '../../issue/reference.ts'
import type { AppDeps } from '../app.ts'
import { repoId } from '../response.ts'
import { run } from '../../runtime/process.ts'
import { ghEnv } from '../../platform/github.ts'
import { errorMessage } from '../../runtime/errors.ts'
import { trustedUserSchema, trustedUsersSchema } from '../feedback.ts'
import { reposSchema } from '../repos.ts'
import { repoTriage, triageOverview, triageOverviewSchema } from '../triage.ts'

const createSchema = Type.Object(
  { ref: Type.String(), token: Type.String(), enabled: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
)
const patchSchema = Type.Object(
  { token: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()) },
  { additionalProperties: false, minProperties: 1 },
)

function responseRepo(row: typeof repos.$inferSelect) {
  return {
    ...row,
    token: maskToken(row.token),
    triageSince: row.triageSince?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function reposRoutes(deps: AppDeps): Hono {
  const { db } = deps
  const app = new Hono()
  app.get('/api/repos', (c) => {
    const body = db.select().from(repos).orderBy(repos.id).all().map(responseRepo)
    if (!Value.Check(reposSchema, body)) throw new Error('仓库数据无效')
    return c.json(body)
  })
  app.get('/api/triage', (c) => {
    const body = triageOverview(db)
    if (!Value.Check(triageOverviewSchema, body)) throw new Error('分诊数据无效')
    return c.json(body)
  })
  app.post('/api/repos', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'JSON 格式无效' }, 400)
    }
    if (!Value.Check(createSchema, body) || !body.token.trim())
      return c.json({ error: '仓库参数无效' }, 400)
    let ref: ReturnType<typeof parseRepoRef>
    try {
      ref = parseRepoRef(body.ref)
    } catch {
      return c.json({ error: '仓库引用无效' }, 400)
    }
    if (ref.platform !== 'github') return c.json({ error: '暂只支持 GitHub 仓库' }, 400)
    const normalized = formatRepoRef(ref)
    if (db.select().from(repos).where(eq(repos.ref, normalized)).get())
      return c.json({ error: '仓库已存在' }, 409)
    const now = new Date()
    const row = db
      .insert(repos)
      .values({
        ...ref,
        ref: normalized,
        token: body.token.trim(),
        enabled: body.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    return c.json(responseRepo(row), 201)
  })
  app.get('/api/repos/:id/triage', (c) => {
    const id = repoId(c.req.param('id'))
    const repo = id ? db.select().from(repos).where(eq(repos.id, id)).get() : undefined
    if (!repo) return c.json({ error: '仓库不存在' }, 404)
    const response = repoTriage(db, repo)
    return c.json(response)
  })
  app.put('/api/repos/:id/triage-level', async (c) => {
    const id = repoId(c.req.param('id'))
    const repo = id ? db.select().from(repos).where(eq(repos.id, id)).get() : undefined
    if (!repo) return c.json({ error: '仓库不存在' }, 404)
    if (repo.platform !== 'github') return c.json({ error: '暂只支持 GitHub' }, 400)
    const body: unknown = await c.req.json().catch(() => null)
    const schema = Type.Object(
      {
        level: Type.Union([
          Type.Literal('off'),
          Type.Literal('shadow'),
          Type.Literal('suggest'),
          Type.Literal('auto'),
        ]),
      },
      { additionalProperties: false },
    )
    if (!Value.Check(schema, body)) return c.json({ error: '分诊级别无效' }, 400)
    db.update(repos)
      .set({ triageLevel: body.level, triageSince: new Date(), updatedAt: new Date() })
      .where(eq(repos.id, repo.id))
      .run()
    return c.json(body)
  })
  app.get('/api/repos/:id/trusted-users', (c) => {
    const id = repoId(c.req.param('id'))
    if (!id || !db.select().from(repos).where(eq(repos.id, id)).get())
      return c.json({ error: '仓库不存在' }, 404)
    const rows = db
      .select()
      .from(trustedUsers)
      .where(eq(trustedUsers.repoId, id))
      .orderBy(trustedUsers.id)
      .all()
      .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
    if (!Value.Check(trustedUsersSchema, rows)) throw new Error('受信账号数据无效')
    return c.json(rows)
  })
  app.post('/api/repos/:id/trusted-users', async (c) => {
    const id = repoId(c.req.param('id'))
    const repo = id ? db.select().from(repos).where(eq(repos.id, id)).get() : undefined
    if (!repo) return c.json({ error: '仓库不存在' }, 404)
    if (repo.platform !== 'github') return c.json({ error: '暂只支持 GitHub' }, 400)
    const body: unknown = await c.req.json().catch(() => null)
    if (!Value.Check(Type.Object({ user: Type.String() }, { additionalProperties: false }), body))
      return c.json({ error: '账号参数无效' }, 400)
    let login = body.user.trim()
    if (login.startsWith('https://')) {
      try {
        const url = new URL(login)
        if (
          url.host.toLowerCase() !== repo.host.toLowerCase() ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !/^\/[^/]+\/?$/.test(url.pathname)
        )
          return c.json({ error: '主页链接的 host 或路径不一致' }, 400)
        login = url.pathname.slice(1).replace(/\/$/, '')
      } catch {
        return c.json({ error: '主页链接无效' }, 400)
      }
    } else if (login.startsWith('@')) login = login.slice(1)
    if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(login)) return c.json({ error: '用户名无效' }, 400)
    let result: unknown
    try {
      const output = await (deps.options.command ?? run)(
        ['gh', 'api', `users/${login}`, '--include'],
        { env: ghEnv(repo.token, repo.host) },
      )
      result = JSON.parse(output.replace(/^HTTP\/[^\n]*\n(?:[^\n]*\n)*?\r?\n/, ''))
    } catch (error) {
      if (/\b404\b/.test(errorMessage(error))) return c.json({ error: '用户不存在' }, 400)
      throw error
    }
    if (!Value.Check(Type.Object({ id: Type.Integer(), login: Type.String() }), result))
      throw new Error('用户数据无效')
    if (
      db
        .select()
        .from(trustedUsers)
        .where(and(eq(trustedUsers.repoId, repo.id), eq(trustedUsers.userId, String(result.id))))
        .get()
    )
      return c.json({ error: '账号已存在' }, 409)
    const row = db
      .insert(trustedUsers)
      .values({
        repoId: repo.id,
        userId: String(result.id),
        login: result.login,
        createdAt: new Date(),
      })
      .returning()
      .get()
    const response = { ...row, createdAt: row.createdAt.toISOString() }
    if (!Value.Check(trustedUserSchema, response)) throw new Error('受信账号数据无效')
    return c.json(response, 201)
  })
  app.delete('/api/repos/:id/trusted-users/:userId', (c) => {
    const id = repoId(c.req.param('id'))
    if (
      !id ||
      !db
        .delete(trustedUsers)
        .where(and(eq(trustedUsers.repoId, id), eq(trustedUsers.userId, c.req.param('userId'))))
        .returning()
        .get()
    )
      return c.json({ error: '受信账号不存在' }, 404)
    return c.body(null, 204)
  })
  app.patch('/api/repos/:id', async (c) => {
    const id = repoId(c.req.param('id'))
    if (!id || !db.select().from(repos).where(eq(repos.id, id)).get())
      return c.json({ error: '仓库不存在' }, 404)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'JSON 格式无效' }, 400)
    }
    if (!Value.Check(patchSchema, body) || (body.token !== undefined && !body.token.trim()))
      return c.json({ error: '仓库参数无效' }, 400)
    const row = db
      .update(repos)
      .set({
        ...(body.token !== undefined ? { token: body.token.trim() } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(repos.id, id))
      .returning()
      .get()
    return c.json(responseRepo(row))
  })
  app.delete('/api/repos/:id', (c) => {
    const id = repoId(c.req.param('id'))
    if (!id || !db.delete(repos).where(eq(repos.id, id)).returning().get())
      return c.json({ error: '仓库不存在' }, 404)
    return c.body(null, 204)
  })
  return app
}
