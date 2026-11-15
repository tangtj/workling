import { readExecutorSettings } from '../config/executor.ts'
import { eq } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { issues, repos, runs } from '../db/schema.ts'
import type { ServeStatus } from '../serve/index.ts'

export type Repo = typeof repos.$inferSelect
export type Run = typeof runs.$inferSelect
export type Issue = typeof issues.$inferSelect & { repo: Repo; runs: Run[]; lastRun: Run | null }
export type PageData = {
  repos: Repo[]
  issues: Issue[]
  now: number
  concurrency: number
  status?: ServeStatus
}

export function pageData(db: WorklingDatabase, now: number, status?: ServeStatus): PageData {
  const allRepos = db.select().from(repos).orderBy(repos.id).all()
  const allRuns = db.select().from(runs).all()
  const allIssues = db
    .select({ issue: issues, repo: repos })
    .from(issues)
    .innerJoin(repos, eq(issues.repoId, repos.id))
    .all()
  return {
    repos: allRepos,
    issues: allIssues.map(({ issue, repo }) => ({
      ...issue,
      repo,
      runs: allRuns
        .filter((run) => run.issueId === issue.id)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()),
      lastRun: allRuns.find((run) => run.id === issue.lastRunId) ?? null,
    })),
    now,
    concurrency: readExecutorSettings(db).concurrency,
    status,
  }
}
export const maskToken = (token: string) => (token.length > 8 ? `****${token.slice(-4)}` : '****')
export const githubUrl = (issue: Issue) =>
  `https://${issue.repo.host}/${issue.repo.path}/issues/${issue.number}`
