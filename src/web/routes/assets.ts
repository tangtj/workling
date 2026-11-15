import timelineJs from '../../web/assets/timeline.js?text' with { type: 'text' }
import runLogJs from '../../web/assets/run-log.js' with { type: 'text' }
import versionJs from '../../web/assets/version.js' with { type: 'text' }
import appJs from '../../web/assets/app.js' with { type: 'text' }
import loginJs from '../../web/assets/login.js' with { type: 'text' }
import styleCss from '../../web/assets/style.css' with { type: 'text' }
// 查询后缀隔离 Bun 的 text loader 缓存，避免与测试中的 ES 模块导入冲突。
import { Hono } from 'hono'
import type { AppDeps } from '../app.ts'
import { webHeaders } from '../response.ts'

export function assetsRoutes(deps: AppDeps): Hono {
  const { options } = deps
  const app = new Hono()
  app.get('/login.js', (c) =>
    c.body(loginJs, 200, {
      ...webHeaders,
      'Content-Type': 'text/javascript; charset=utf-8',
    }),
  )
  app.get('/version.js', (c) =>
    c.body(versionJs, 200, { ...webHeaders, 'Content-Type': 'text/javascript; charset=utf-8' }),
  )
  app.get('/app.js', (c) =>
    c.body(appJs, 200, { ...webHeaders, 'Content-Type': 'text/javascript; charset=utf-8' }),
  )
  app.get('/timeline.js', (c) =>
    c.body(timelineJs, 200, { ...webHeaders, 'Content-Type': 'text/javascript; charset=utf-8' }),
  )
  app.get('/run-log.js', (c) =>
    c.body(runLogJs, 200, { ...webHeaders, 'Content-Type': 'text/javascript; charset=utf-8' }),
  )
  app.get('/style.css', (c) =>
    c.body(styleCss, 200, { ...webHeaders, 'Content-Type': 'text/css; charset=utf-8' }),
  )
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
