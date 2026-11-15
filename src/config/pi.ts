import { eq } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { piSettings } from '../db/schema.ts'
import type { Environment } from '../runtime/types.ts'

export type PiSettings = {
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh'
  piModel: string | null
  llmBaseUrl: string | null
  llmApiKey: string | null
  llmApi: 'openai-responses' | 'openai-completions'
  gitName: string
  gitEmail: string
}

export function parsePiSettings(input: Record<string, unknown>): PiSettings {
  const text = (field: string, fallback: string | null): string | null => {
    const value = input[field] === undefined ? fallback : input[field]
    if (value === null && fallback === null) return null
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`${field} 的值无效：${String(value)}`)
    return value
  }
  const model = text('model', 'gpt-6.1-terra')!
  const effort = text('effort', 'medium')
  if (effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'xhigh')
    throw new Error(`effort 的值无效：${effort}`)
  const piModel = text('piModel', null)
  const llmBaseUrl = text('llmBaseUrl', null)
  let llmApiKey: string | null = null
  if (llmBaseUrl !== null) {
    let url: URL
    try {
      url = new URL(llmBaseUrl)
    } catch {
      throw new Error(`llmBaseUrl 的值无效：${llmBaseUrl}`)
    }
    if (
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) ||
      !url.hostname
    )
      throw new Error(`llmBaseUrl 的值无效：${llmBaseUrl}`)
    if (typeof input.llmApiKey !== 'string' || !input.llmApiKey.trim())
      throw new Error('设置 llmBaseUrl 时必须同时设置 llmApiKey')
    llmApiKey = input.llmApiKey
  }
  const llmApi = text('llmApi', 'openai-responses')
  if (llmApi !== 'openai-responses' && llmApi !== 'openai-completions')
    throw new Error(`llmApi 的值无效：${llmApi}`)
  const gitName = text('gitName', 'workling')!
  const gitEmail = text('gitEmail', 'workling@users.noreply.github.com')!
  if (!gitEmail.includes('@')) throw new Error(`gitEmail 的值无效：${gitEmail}`)
  return {
    model,
    effort,
    piModel,
    llmBaseUrl: llmBaseUrl?.replace(/\/+$/, '') ?? null,
    llmApiKey,
    llmApi,
    gitName,
    gitEmail,
  }
}

export function readPiSettings(db: Pick<WorklingDatabase, 'select'>): PiSettings {
  const row = db.select().from(piSettings).where(eq(piSettings.id, 1)).get()
  return parsePiSettings(row ?? {})
}

const environmentFields = {
  model: 'WORKLING_MODEL',
  effort: 'WORKLING_EFFORT',
  piModel: 'WORKLING_PI_MODEL',
  llmBaseUrl: 'WORKLING_LLM_BASE_URL',
  llmApiKey: 'WORKLING_LLM_API_KEY',
  llmApi: 'WORKLING_LLM_API',
  gitName: 'WORKLING_GIT_NAME',
  gitEmail: 'WORKLING_GIT_EMAIL',
} as const

export function importPiSettings(
  db: WorklingDatabase,
  env: Environment,
): { imported: boolean; ignored: string[] } {
  return db.transaction((tx) => {
    if (tx.select().from(piSettings).where(eq(piSettings.id, 1)).get())
      return {
        imported: false,
        ignored: Object.values(environmentFields).filter((name) => env[name] !== undefined),
      }
    // 已部署实例首次升级时沿用原环境变量，之后以管理页保存的配置为准。
    let pi: PiSettings
    try {
      pi = parsePiSettings(
        Object.fromEntries(
          Object.entries(environmentFields).map(([field, name]) => [field, env[name]]),
        ),
      )
    } catch (error) {
      if (!(error instanceof Error)) throw error
      throw new Error(
        error.message.replace(
          /\b(model|effort|piModel|llmBaseUrl|llmApiKey|llmApi|gitName|gitEmail)\b/g,
          (field) => environmentFields[field as keyof PiSettings],
        ),
      )
    }
    tx.insert(piSettings)
      .values({ id: 1, ...pi, updatedAt: new Date() })
      .run()
    return { imported: true, ignored: [] }
  })
}

export function updatePiSettings(
  db: WorklingDatabase,
  patch: Record<string, unknown>,
  now = new Date(),
): PiSettings {
  return db.transaction((tx) => {
    const current = readPiSettings(tx)
    const merged = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    }
    if (patch.llmApiKey === '' || patch.llmApiKey === undefined)
      merged.llmApiKey = current.llmApiKey
    if (merged.llmBaseUrl === null) merged.llmApiKey = null
    const pi = parsePiSettings(merged)
    tx.insert(piSettings)
      .values({ id: 1, ...pi, updatedAt: now })
      .onConflictDoUpdate({ target: piSettings.id, set: { ...pi, updatedAt: now } })
      .run()
    return pi
  })
}
