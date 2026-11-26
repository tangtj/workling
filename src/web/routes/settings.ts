import * as Type from 'typebox'
import { readUpdateChannel, updateUpdateChannel } from '../../config/update.ts'
import { updateSettingsSchema } from '../settings.ts'
import { readExecutorSettings, updateExecutorSettings } from '../../config/executor.ts'
import { Hono } from 'hono'
import * as Value from 'typebox/value'
import { readPiSettings, updatePiSettings } from '../../config/pi.ts'
import type { AppDeps } from '../app.ts'
import { responsePi } from '../response.ts'
import { settingsSchema } from '../settings.ts'
import { WORKLING_LABELS } from '../../serve/poll.ts'

const piPatchSchema = Type.Object(
  {
    model: Type.Optional(Type.String()),
    effort: Type.Optional(Type.String()),
    reviewModel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    reviewEffort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    planModel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    planEffort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    piModel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    llmBaseUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    llmApiKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    llmApi: Type.Optional(Type.String()),
    gitName: Type.Optional(Type.String()),
    gitEmail: Type.Optional(Type.String()),
  },
  { additionalProperties: false, minProperties: 1 },
)

const executorPatchSchema = Type.Object(
  {
    concurrency: Type.Optional(Type.Number()),
    sandbox: Type.Optional(Type.String()),
    taskImage: Type.Optional(Type.String()),
    taskCpus: Type.Optional(Type.Number()),
    taskMemory: Type.Optional(Type.String()),
    taskPids: Type.Optional(Type.Number()),
    taskNetwork: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false, minProperties: 1 },
)

export function settingsRoutes(deps: AppDeps): Hono {
  const { db } = deps
  const app = new Hono()
  app.get('/api/settings', (c) => {
    const body = {
      update: { channel: readUpdateChannel(db) },
      pi: responsePi(readPiSettings(db)),
      executor: readExecutorSettings(db),
      startup: deps.options.startup ?? null,
      labels: WORKLING_LABELS.map(({ name, description }) => ({ name, description })),
    }
    if (!Value.Check(settingsSchema, body)) throw new Error('设置数据无效')
    return c.json(body, 200, { 'Cache-Control': 'no-store' })
  })
  app.patch('/api/settings/update', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'JSON 格式无效' }, 400)
    }
    if (!Value.Check(updateSettingsSchema, body)) return c.json({ error: '参数无效' }, 400)
    return c.json(updateUpdateChannel(db, body.channel))
  })
  app.get('/api/settings/pi', (c) => c.json(responsePi(readPiSettings(db))))
  app.patch('/api/settings/pi', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'JSON 格式无效' }, 400)
    }
    if (!Value.Check(piPatchSchema, body)) return c.json({ error: '参数无效' }, 400)
    if (
      readExecutorSettings(db).sandbox === 'docker' &&
      (body.llmBaseUrl === null ||
        (body.llmBaseUrl === undefined && readPiSettings(db).llmBaseUrl === null))
    )
      return c.json({ error: 'docker 沙箱必须配置 LLM 接入地址' }, 400)
    try {
      return c.json(responsePi(updatePiSettings(db, body)))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  app.get('/api/settings/executor', (c) => c.json(readExecutorSettings(db)))
  app.patch('/api/settings/executor', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'JSON 格式无效' }, 400)
    }
    if (!Value.Check(executorPatchSchema, body)) return c.json({ error: '参数无效' }, 400)
    try {
      if (
        (body.sandbox ?? readExecutorSettings(db).sandbox) === 'docker' &&
        readPiSettings(db).llmBaseUrl === null
      )
        return c.json({ error: 'docker 沙箱必须先配置 LLM 接入地址' }, 400)
      return c.json(updateExecutorSettings(db, body))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  return app
}
