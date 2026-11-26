import type * as Type from 'typebox'
import * as Value from 'typebox/value'
import { feedbackSchema } from '../feedback.ts'
import { Hono } from 'hono'
import { and, desc, eq, ne } from 'drizzle-orm'
import { repos, issues, runs, feedback, reviews } from '../../db/schema.ts'
import type { AppDeps } from '../app.ts'
import { reviewSchema } from '../../contract/out.ts'
import type { IssueReview } from '../review.ts'
import { repoId } from '../response.ts'

function responseRun(row: typeof runs.$inferSelect) {
  return {
    id: row.id,
    worker: row.worker,
    kind: row.kind,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    exitCode: row.exitCode,
    error: row.error,
    summary: row.summary,
    reportResult: row.reportResult,
    executor: row.executor,
    difficulty: row.difficulty,
    clarity: row.clarity,
    assessmentNote: row.assessmentNote,
    logTail: row.logTail,
  }
}

function parseArray<T extends Type.TSchema>(schema: T, text: string | null): Type.Static<T> | [] {
  if (text === null) return []
  try {
    const value: unknown = JSON.parse(text)
    return Value.Check(schema, value) ? value : []
  } catch {
    return []
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
        prState: issue.prState,
        lastRun: lastRun ? responseRun(lastRun) : null,
        createdAt: issue.createdAt.toISOString(),
        updatedAt: issue.updatedAt.toISOString(),
      })),
    )
  })
  app.get('/api/issues/:id/feedback', (c) => {
    const id = repoId(c.req.param('id'))
    if (!id || !db.select().from(issues).where(eq(issues.id, id)).get())
      return c.json({ error: 'Issue 不存在' }, 404)
    const rows = db
      .select()
      .from(feedback)
      .where(eq(feedback.issueId, id))
      .orderBy(feedback.createdAt, feedback.id)
      .all()
      .map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        seenAt: row.seenAt.toISOString(),
      }))
    if (!Value.Check(feedbackSchema, rows)) throw new Error('反馈数据无效')
    return c.json(rows)
  })
  app.get('/api/issues/:id/runs', (c) => {
    const id = repoId(c.req.param('id'))
    if (!id || !db.select().from(issues).where(eq(issues.id, id)).get())
      return c.json({ error: 'Issue 不存在' }, 404)
    return c.json(
      db
        .select()
        .from(runs)
        .where(and(eq(runs.issueId, id), ne(runs.kind, 'review')))
        .orderBy(desc(runs.startedAt))
        .all()
        .map((row) => ({ ...responseRun(row), taskDir: row.taskDir })),
    )
  })
  app.get('/api/issues/:id/reviews', (c) => {
    const id = repoId(c.req.param('id'))
    if (!id || !db.select().from(issues).where(eq(issues.id, id)).get())
      return c.json({ error: 'Issue 不存在' }, 404)
    const { checks, acceptance, findings } = reviewSchema.properties
    const rows: IssueReview[] = db
      .select()
      .from(reviews)
      .where(eq(reviews.issueId, id))
      .orderBy(desc(reviews.id))
      .all()
      .map((row) => ({
        id: row.id,
        status: row.status,
        verdict: row.verdict,
        summary: row.summary,
        checks: parseArray(checks, row.checks),
        acceptance: parseArray(acceptance, row.acceptance),
        findings: parseArray(findings, row.findings),
        error: row.error,
        model: row.model,
        effort: row.effort,
        partial: row.partial,
        headSha: row.headSha,
        runId: row.runId,
        deliveryRunId: row.deliveryRunId,
        createdAt: row.createdAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
      }))
    return c.json(rows)
  })
  return app
}
