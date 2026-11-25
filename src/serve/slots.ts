import { and, count, eq, isNull } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { issues, runs } from '../db/schema.ts'

export function countRunningTasks(db: WorklingDatabase): number {
  const issuesRunning = db
    .select({ count: count() })
    .from(issues)
    .where(eq(issues.status, 'running'))
    .get()!.count
  const reviewsRunning = db
    .select({ count: count() })
    .from(runs)
    .where(and(eq(runs.kind, 'review'), isNull(runs.endedAt)))
    .get()!.count
  return issuesRunning + reviewsRunning
}
