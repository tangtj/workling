// 查询后缀隔离 Bun 的 text loader 缓存，避免与测试中的 ES 模块导入冲突。
import { Hono } from 'hono'
import type { AppDeps } from '../app.ts'
import { webHeaders } from '../response.ts'
import { assetContents, assetHashes, type AssetName } from '../assets.ts'

export function assetsRoutes(deps: AppDeps): Hono {
  const { options } = deps
  const app = new Hono()
  for (const name of Object.keys(assetContents) as AssetName[]) {
    app.get(`/${name}`, (c) =>
      c.body(assetContents[name], 200, {
        ...webHeaders,
        'Content-Type': name.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/javascript; charset=utf-8',
        'Cache-Control':
          c.req.query('v') === assetHashes[name]
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
      }),
    )
  }
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
