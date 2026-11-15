import * as Type from 'typebox'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { changePassword, hashToken, randomToken } from '../../web/auth.ts'
import { eq } from 'drizzle-orm'
import * as Value from 'typebox/value'
import { admin, sessions } from '../../db/schema.ts'
import type { AppDeps } from '../app.ts'

const loginSchema = Type.Object({ password: Type.String() }, { additionalProperties: false })
const passwordSchema = Type.Object(
  { currentPassword: Type.String(), newPassword: Type.String() },
  { additionalProperties: false },
)
const sessionSeconds = 7 * 24 * 60 * 60
const loginWindow = 15 * 60 * 1000
const cookieAttributes = 'HttpOnly; SameSite=Strict; Path=/'

export function sessionRoutes(deps: AppDeps): Hono {
  const { db, options } = deps
  const now = options.now ?? Date.now
  let failures = 0
  let windowStart = 0
  const limited = () => {
    if (now() - windowStart >= loginWindow) failures = 0
    return failures >= 5
  }
  const recordFailure = () => {
    // 异步验证后重新检查窗口，避免并行请求丢失失败次数。
    const failedAt = now()
    if (failedAt - windowStart >= loginWindow) failures = 0
    if (failures === 0) windowStart = failedAt
    failures++
  }
  const app = new Hono()
  app.post('/login', async (c) => {
    if (limited()) return c.json({ error: '尝试次数过多，请稍后再试' }, 429)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'JSON 格式无效' }, 400)
    }
    if (!Value.Check(loginSchema, body)) return c.json({ error: '登录参数无效' }, 400)
    const account = db.select().from(admin).where(eq(admin.id, 1)).get()
    const valid = account && (await Bun.password.verify(body.password, account.passwordHash))
    if (!valid) {
      recordFailure()
      return c.json({ error: '密码不正确' }, 401)
    }
    // reset-password 可由另一个进程执行，验证期间密码发生变化时不能签发旧密码会话。
    const token = randomToken(32)
    const inserted = db.transaction((tx) => {
      if (
        tx.select().from(admin).where(eq(admin.id, 1)).get()?.passwordHash !== account.passwordHash
      )
        return false
      const createdAt = new Date(now())
      tx.insert(sessions)
        .values({
          id: hashToken(token),
          createdAt,
          expiresAt: new Date(createdAt.getTime() + sessionSeconds * 1000),
        })
        .run()
      return true
    })
    if (!inserted) return c.json({ error: '密码不正确' }, 401)
    failures = 0
    c.header(
      'Set-Cookie',
      `workling_session=${token}; ${cookieAttributes}; Max-Age=${sessionSeconds}${options.secureCookie ? '; Secure' : ''}`,
    )
    return c.body(null, 204)
  })
  app.post('/api/password', async (c) => {
    if (limited()) return c.json({ error: '尝试次数过多，请稍后再试' }, 429)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'JSON 格式无效' }, 400)
    }
    if (!Value.Check(passwordSchema, body)) return c.json({ error: '参数无效' }, 400)
    if ([...body.newPassword].length < 12 || [...body.newPassword].length > 128)
      return c.json({ error: '新密码长度须为 12–128 个字符' }, 400)
    if (body.currentPassword === body.newPassword)
      return c.json({ error: '新密码不能与当前密码相同' }, 400)
    const account = db.select().from(admin).where(eq(admin.id, 1)).get()
    if (!account || !(await Bun.password.verify(body.currentPassword, account.passwordHash))) {
      recordFailure()
      return c.json({ error: '当前密码不正确' }, 401)
    }
    const passwordHash = await Bun.password.hash(body.newPassword, 'argon2id')
    const token = getCookie(c, 'workling_session')!
    if (!changePassword(db, account.passwordHash, passwordHash, hashToken(token)))
      return c.json({ error: '当前密码不正确' }, 401)
    failures = 0
    return c.body(null, 204)
  })
  app.post('/logout', (c) => {
    const token = getCookie(c, 'workling_session')
    if (token)
      db.delete(sessions)
        .where(eq(sessions.id, hashToken(token)))
        .run()
    c.header(
      'Set-Cookie',
      `workling_session=; ${cookieAttributes}; Max-Age=0${options.secureCookie ? '; Secure' : ''}`,
    )
    return c.body(null, 204)
  })
  return app
}
