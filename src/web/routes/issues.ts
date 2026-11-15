import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { repos, issues, runs } from '../../db/schema.ts'
import type { AppDeps } from '../app.ts'
import { repoId } from '../response.ts'

function responseRun(row: typeof runs.$inferSelect) {
  return {
    id: row.id,
    worker: row.worker,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    exitCode: row.exitCode,
    error: row.error,
    summary: row.summary,
    reportResult: row.reportResult,
    logTail: row.logTail,
  }
}

export function issuesRoutes(deps: AppDeps): Hono {
  const { db } = deps
  const app = new Hono()
  app.get('/api/issues', (c) => {
    const rows = db
      .select({ issue: issues, repo: repos, lastRun: runs })
      .from(issues)
      .innerJoin(repos, eq(issues.repoId, repos.id))
      .leftJoin(runs, eq(issues.lastRunId, runs.id))
      .orderBy(desc(issues.updatedAt))
      .all()
    return c.json(
      rows.map(({ issue, repo, lastRun }) => ({
        id: issue.id,
        repoId: issue.repoId,
        ref: repo.ref,
        number: issue.number,
        title: issue.title,
        url: `https://${repo.host}/${repo.path}/issues/${issue.number}`,
        status: issue.status,
        prUrl: issue.prUrl,
        lastRun: lastRun ? responseRun(lastRun) : null,
        createdAt: issue.createdAt.toISOString(),
        updatedAt: issue.updatedAt.toISOString(),
      })),
    )
  })
  app.get('/api/issues/:id/runs', (c) => {
    const id = repoId(c.req.param('id'))
    if (!id || !db.select().from(issues).where(eq(issues.id, id)).get())
      return c.json({ error: 'Issue 不存在' }, 404)
    return c.json(
      db
        .select()
        .from(runs)
        .where(eq(runs.issueId, id))
        .orderBy(desc(runs.startedAt))
        .all()
        .map((row) => ({ ...responseRun(row), taskDir: row.taskDir })),
    )
  })
  return app
}
