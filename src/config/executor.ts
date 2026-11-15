import { eq } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { executorSettings } from '../db/schema.ts'
import type { Environment } from '../runtime/types.ts'

// 同时运行的任务数默认值。
export const DEFAULT_CONCURRENCY = 3

export type ExecutorSettings = {
  concurrency: number
  sandbox: 'none' | 'docker'
  taskImage: string
  taskCpus: number
  taskMemory: string
  taskPids: number
  taskNetwork: string | null
}

export function parseExecutorSettings(input: Record<string, unknown>): ExecutorSettings {
  const text = (field: string, fallback: string | null): string | null => {
    const value = input[field] === undefined ? fallback : input[field]
    if (value === null && fallback === null) return null
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`${field} 的值无效：${String(value)}`)
    return value
  }
  const concurrency = input.concurrency === undefined ? DEFAULT_CONCURRENCY : input.concurrency
  if (
    typeof concurrency !== 'number' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32
  )
    throw new Error(`concurrency 的值无效：${String(concurrency)}`)
  const sandbox = input.sandbox === undefined ? 'none' : input.sandbox
  if (sandbox === 'codex') throw new Error('sandbox=codex 尚未实现（M1.5）')
  if (sandbox !== 'none' && sandbox !== 'docker')
    throw new Error(`sandbox 的值无效：${String(sandbox)}`)
  const taskImage = text('taskImage', 'workling:local')!
  const taskCpus = input.taskCpus === undefined ? 2 : input.taskCpus
  if (typeof taskCpus !== 'number' || !Number.isFinite(taskCpus) || taskCpus <= 0 || taskCpus > 64)
    throw new Error(`taskCpus 的值无效：${String(taskCpus)}`)
  const taskMemory = text('taskMemory', '4g')!
  if (!/^[1-9]\d*[mg]$/.test(taskMemory)) throw new Error(`taskMemory 的值无效：${taskMemory}`)
  const taskPids = input.taskPids === undefined ? 1024 : input.taskPids
  if (
    typeof taskPids !== 'number' ||
    !Number.isInteger(taskPids) ||
    taskPids < 64 ||
    taskPids > 65536
  )
    throw new Error(`taskPids 的值无效：${String(taskPids)}`)
  const taskNetwork = text('taskNetwork', null)
  return { concurrency, sandbox, taskImage, taskCpus, taskMemory, taskPids, taskNetwork }
}

export function readExecutorSettings(db: Pick<WorklingDatabase, 'select'>): ExecutorSettings {
  const row = db.select().from(executorSettings).where(eq(executorSettings.id, 1)).get()
  return parseExecutorSettings(row ?? {})
}

const environmentFields = {
  sandbox: 'WORKLING_SANDBOX',
  taskImage: 'WORKLING_TASK_IMAGE',
  taskCpus: 'WORKLING_TASK_CPUS',
  taskMemory: 'WORKLING_TASK_MEMORY',
  taskPids: 'WORKLING_TASK_PIDS',
  taskNetwork: 'WORKLING_TASK_NETWORK',
} as const

export function importExecutorSettings(
  db: WorklingDatabase,
  env: Environment,
): { imported: boolean; ignored: string[] } {
  return db.transaction((tx) => {
    if (tx.select().from(executorSettings).where(eq(executorSettings.id, 1)).get())
      return {
        imported: false,
        ignored: Object.values(environmentFields).filter((name) => env[name] !== undefined),
      }
    // 首次升级沿用环境变量，之后以管理页保存的配置为准。
    let config: ExecutorSettings
    try {
      const input: Record<string, unknown> = Object.fromEntries(
        Object.entries(environmentFields).map(([field, name]) => [field, env[name]]),
      )
      if (env.WORKLING_TASK_CPUS !== undefined) input.taskCpus = Number(env.WORKLING_TASK_CPUS)
      if (env.WORKLING_TASK_PIDS !== undefined) {
        if (!/^\d+$/.test(env.WORKLING_TASK_PIDS))
          throw new Error(`taskPids 的值无效：${env.WORKLING_TASK_PIDS}`)
        input.taskPids = Number(env.WORKLING_TASK_PIDS)
      }
      config = parseExecutorSettings(input)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      throw new Error(
        error.message.replace(
          /\b(sandbox|taskImage|taskCpus|taskMemory|taskPids|taskNetwork)\b/g,
          (field) => environmentFields[field as keyof typeof environmentFields],
        ),
      )
    }
    tx.insert(executorSettings)
      .values({ id: 1, ...config, updatedAt: new Date() })
      .run()
    return { imported: true, ignored: [] }
  })
}

export function updateExecutorSettings(
  db: WorklingDatabase,
  patch: Record<string, unknown>,
  now = new Date(),
): ExecutorSettings {
  return db.transaction((tx) => {
    const config = parseExecutorSettings({
      ...readExecutorSettings(tx),
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    })
    tx.insert(executorSettings)
      .values({ id: 1, ...config, updatedAt: now })
      .onConflictDoUpdate({ target: executorSettings.id, set: { ...config, updatedAt: now } })
      .run()
    return config
  })
}
