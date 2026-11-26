import { statSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { issues, runs } from '../db/schema.ts'

export function waitForNext({
  seconds,
  signal,
  db,
  immediate,
}: {
  seconds: number
  signal: AbortSignal
  db: WorklingDatabase
  immediate: boolean
}): Promise<'interval' | 'finished' | 'immediate' | 'aborted'> {
  if (immediate) return Promise.resolve('immediate')
  if (signal.aborted) return Promise.resolve('aborted')

  const running = () => [
    ...db
      .select({ id: runs.id, taskDir: runs.taskDir })
      .from(issues)
      .innerJoin(runs, eq(issues.lastRunId, runs.id))
      .where(eq(issues.status, 'running'))
      .all(),
    ...db
      .select({ id: runs.id, taskDir: runs.taskDir })
      .from(runs)
      .where(and(eq(runs.kind, 'review'), isNull(runs.endedAt)))
      .all(),
  ]
  const hasResult = (taskDir: string | null) => {
    if (!taskDir) return false
    try {
      statSync(join(taskDir, 'result.json'))
      return true
    } catch {
      return false
    }
  }
  // 对账失败留下的结果不能在每次等待时反复触发唤醒。
  const existing = new Set(
    running()
      .filter((run) => hasResult(run.taskDir))
      .map((run) => run.id),
  )

  return new Promise((resolve) => {
    const done = (reason: 'interval' | 'finished' | 'aborted') => {
      clearTimeout(intervalTimer)
      clearInterval(checkTimer)
      signal.removeEventListener('abort', abort)
      resolve(reason)
    }
    const abort = () => done('aborted')
    const intervalTimer = setTimeout(() => done('interval'), seconds * 1000)
    const checkTimer = setInterval(
      () => {
        if (running().some((run) => !existing.has(run.id) && hasResult(run.taskDir)))
          done('finished')
      },
      Math.min(5, seconds) * 1000,
    )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
