// 查询后缀隔离 Bun 的 text loader 缓存，避免与测试中的 ES 模块导入冲突。
import { Hono } from 'hono'
import type { AppDeps } from '../app.ts'
import { getWebBundle } from '../bundle.ts'
import { webHeaders } from '../response.ts'

export function assetsRoutes(deps: AppDeps): Hono {
  const { options } = deps
  const app = new Hono()
  app.get('/assets/:name', async (c) => {
    const file = (await getWebBundle()).files.get(c.req.path)
    if (!file) return c.body(null, 404, webHeaders)
    return c.body(new Uint8Array(file.body), 200, {
      ...webHeaders,
      'Content-Type': file.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
  })
  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/api/status', (c) => {
    const status = options.status?.()
    return c.json({
      watch: status
        ? {
            ...status,
            startedAt: status.startedAt.toISOString(),
            lastPollAt: status.lastPollAt?.toISOString() ?? null,
          }
        : null,
    })
  })
  return app
}
