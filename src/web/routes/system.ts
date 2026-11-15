import { Hono } from 'hono'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { TAG_PATTERN } from '../../runtime/version.ts'
import {
  getJob,
  cancelJob,
  localVersionInfo,
  startUpdate,
  versionInfo,
} from '../../update/index.ts'
import type { AppDeps } from '../app.ts'

const mode = Type.Optional(Type.Union([Type.Literal('drain'), Type.Literal('now')]))
const updateSchema = Type.Object(
  { tag: Type.String({ pattern: TAG_PATTERN }), mode },
  { additionalProperties: false },
)

export function systemRoutes({ db, options }: AppDeps): Hono {
  const app = new Hono()
  app.get('/api/system/version', async (c) =>
    c.json(
      c.req.query('local') === '1'
        ? localVersionInfo(db)
        : await versionInfo({ db, force: c.req.query('force') === '1' }),
    ),
  )
  app.get('/api/system/job', (c) => c.json(getJob()))
  app.post('/api/system/job/cancel', async (c) => {
    try {
      return c.json({ job: await cancelJob() })
    } catch {
      return c.json({ error: '仅等待中的作业可以取消' }, 409)
    }
  })
  app.post('/api/system/update', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'JSON 格式无效' }, 400)
    }
    if (!Value.Check(updateSchema, body)) return c.json({ error: '参数无效' }, 400)
    try {
      const job = await startUpdate({ db, data: options.workspace, tag: body.tag, mode: body.mode })
      return c.json({ job }, 202)
    } catch (error) {
      const status =
        error instanceof Error &&
        'status' in error &&
        (error.status === 400 || error.status === 409)
          ? error.status
          : 400
      const token = process.env.WORKLING_UPDATE_TOKEN
      const message = error instanceof Error ? error.message : '更新失败'
      return c.json({ error: token ? message.replaceAll(token, '***') : message }, status)
    }
  })
  return app
}
