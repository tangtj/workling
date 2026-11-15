import * as Type from 'typebox'
import { readExecutorSettings, updateExecutorSettings } from '../../config/executor.ts'
import { Hono } from 'hono'
import * as Value from 'typebox/value'
import { readPiSettings, updatePiSettings } from '../../config/pi.ts'
import type { AppDeps } from '../app.ts'
import { responsePi } from '../response.ts'

const piPatchSchema = Type.Object(
  {
    model: Type.Optional(Type.String()),
    effort: Type.Optional(Type.String()),
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
