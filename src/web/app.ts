import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { hashToken } from '../web/auth.ts'
import { eq } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { sessions } from '../db/schema.ts'
import type { ServeStatus } from '../serve/index.ts'
import { Layout } from './views/layout.tsx'
import { NotFoundPage } from './views/not-found.tsx'

import { pageData } from './data.ts'
import { sessionRoutes } from './routes/session.ts'
import { pagesRoutes } from './routes/pages.ts'
import { settingsRoutes } from './routes/settings.ts'
import { reposRoutes } from './routes/repos.ts'
import { issuesRoutes } from './routes/issues.ts'
import { runsRoutes } from './routes/runs.ts'
import { assetsRoutes } from './routes/assets.ts'
import { html, headers } from './response.ts'

export type AppOptions = {
  workspace: string
  secrets?: () => string[]
  now?: () => number
  allowedHosts?: string[]
  secureCookie?: boolean
  startup?: {
    workspace: string
    worker: string
    host: string
    port: number
    allowedHosts: string[]
    secureCookie: boolean
  }
  status?: () => ServeStatus
}
export type AppDeps = { db: WorklingDatabase; options: AppOptions }

export function createApp(db: WorklingDatabase, options: AppOptions) {
  const now = options.now ?? Date.now
  const app = new Hono()
  app.use('*', async (c, next) => {
    // 校验 Host 防止 DNS rebinding 将本机接口暴露给恶意网站。部署时通过 WORKLING_ALLOWED_HOSTS 放行服务器域名。
    const header = c.req.header('host') ?? ''
    const host = (
      header.startsWith('[') ? header.slice(1, header.indexOf(']')) : header.split(':')[0]!
    ).toLowerCase()
    if (!['127.0.0.1', 'localhost', '::1', ...(options.allowedHosts ?? [])].includes(host))
      return c.json({ error: '禁止访问' }, 403)
    // 要求 JSON 使浏览器跨站表单不能直接提交修改请求。
    if (
      (c.req.method === 'POST' || c.req.method === 'PATCH') &&
      !/^application\/json\s*(?:;|$)/i.test(c.req.header('content-type') ?? '')
    )
      return c.json({ error: '请求类型必须为 application/json' }, 415)
    await next()
  })
  app.use('*', async (c, next) => {
    const token = getCookie(c, 'workling_session')
    const session = token
      ? db
          .select()
          .from(sessions)
          .where(eq(sessions.id, hashToken(token)))
          .get()
      : undefined
    const authenticated = session !== undefined && session.expiresAt.getTime() > now()
    if (session && !authenticated) db.delete(sessions).where(eq(sessions.id, session.id)).run()
    const path = c.req.path
    if (c.req.method === 'GET' && path === '/login' && authenticated) return c.redirect('/')
    const publicRoute =
      (c.req.method === 'GET' && ['/health', '/login', '/login.js', '/style.css'].includes(path)) ||
      (c.req.method === 'POST' && path === '/login')
    if (!authenticated && !publicRoute && !(c.req.method === 'POST' && path === '/logout')) {
      if (c.req.method === 'GET' && !path.startsWith('/api/')) return c.redirect('/login')
      return c.json({ error: '未登录' }, 401)
    }
    await next()
  })
  const deps = { db, options }
  app.route('/', sessionRoutes(deps))
  app.route('/', pagesRoutes(deps))
  app.route('/', settingsRoutes(deps))
  app.route('/', reposRoutes(deps))
  app.route('/', issuesRoutes(deps))
  app.route('/', runsRoutes(deps))
  app.route('/', assetsRoutes(deps))
  const data = () => pageData(db, now(), options.status?.())
  app.notFound((c) => {
    if (c.req.method !== 'GET' || c.req.path.startsWith('/api/'))
      return c.json({ error: '资源不存在' }, 404)
    const sidebar = data()
    return c.body(
      html(Layout({ title: '页面不存在', active: '', sidebar, children: NotFoundPage() })),
      404,
      headers,
    )
  })
  app.onError((_error, c) => c.json({ error: '服务器内部错误' }, 500))
  return app
}
