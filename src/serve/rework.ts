import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { feedback, issues, repos, runs } from '../db/schema.ts'
import { ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'

type Row = typeof feedback.$inferSelect
type Candidate = { issue: typeof issues.$inferSelect; run: typeof runs.$inferSelect }

export function selectBatch({ issue, run }: Candidate, rows: Row[]): Row[] {
  const number = Number(/\/pull\/(\d+)(?:[/?#]|$)/.exec(issue.prUrl ?? '')?.[1] ?? 0)
  return rows.filter(
    (row) =>
      row.status === 'observed' &&
      row.createdAt > run.startedAt &&
      (row.prNumber === null || (number !== 0 && row.prNumber === number)),
  )
}

export async function queueRework({
  db,
  command,
  log,
  signal,
}: {
  db: WorklingDatabase
  command: Command
  log: (message: string) => void
  signal: AbortSignal
}) {
  const candidates = db
    .select({ issue: issues, run: runs, repo: repos })
    .from(issues)
    .innerJoin(runs, eq(issues.lastRunId, runs.id))
    .innerJoin(repos, eq(issues.repoId, repos.id))
    .where(
      and(
        eq(repos.enabled, true),
        eq(repos.platform, 'github'),
        inArray(issues.status, ['done', 'failed']),
        or(isNull(issues.prState), eq(issues.prState, 'open')),
      ),
    )
    .all()
  for (const candidate of candidates) {
    if (signal.aborted) break
    const { issue, repo } = candidate
    const batch = selectBatch(
      candidate,
      db.select().from(feedback).where(eq(feedback.issueId, issue.id)).all(),
    )
    if (!batch.length) continue
    const updated = db.transaction((tx) => {
      const row = tx
        .update(issues)
        .set({ status: 'queued', updatedAt: new Date() })
        .where(and(eq(issues.id, issue.id), eq(issues.status, issue.status)))
        .returning()
        .get()
      if (!row) return false
      tx.update(feedback)
        .set({ status: 'pending' })
        .where(
          and(
            inArray(
              feedback.id,
              batch.map((item) => item.id),
            ),
            eq(feedback.status, 'observed'),
          ),
        )
        .run()
      return true
    })
    if (!updated) continue
    log(`${repo.ref} #${issue.number} 收到 ${batch.length} 条反馈，重新入队`)
    try {
      await command(
        [
          'gh',
          'issue',
          'edit',
          String(issue.number),
          '-R',
          repo.path,
          '--remove-label',
          `workling:${issue.status}`,
          '--add-label',
          'workling:queued',
        ],
        { env: ghEnv(repo.token, repo.host), signal },
      )
    } catch (error) {
      if (!signal.aborted) log(`${repo.ref} #${issue.number} 更新标签失败：${errorMessage(error)}`)
    }
  }
}
