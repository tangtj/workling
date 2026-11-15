import { maskToken } from '../data.ts'
import * as Type from 'typebox'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import * as Value from 'typebox/value'
import { repos } from '../../db/schema.ts'
import { formatRepoRef, parseRepoRef } from '../../issue/reference.ts'
import type { AppDeps } from '../app.ts'
import { repoId } from '../response.ts'

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function reposRoutes(deps: AppDeps): Hono {
  const { db } = deps
  const app = new Hono()
  app.get('/api/repos', (c) =>
    c.json(db.select().from(repos).orderBy(repos.id).all().map(responseRepo)),
  )
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
