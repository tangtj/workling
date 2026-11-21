import { and, eq } from 'drizzle-orm'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import type { WorklingDatabase } from '../db/index.ts'
import { feedback, issues, repos } from '../db/schema.ts'
import { ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'

const schema = Type.Array(
  Type.Object({
    number: Type.Number(),
    url: Type.String(),
    headRefName: Type.String(),
    state: Type.Union([Type.Literal('OPEN'), Type.Literal('MERGED'), Type.Literal('CLOSED')]),
    updatedAt: Type.String({ format: 'date-time' }),
  }),
)

export async function syncPullRequests({
  db,
  command,
  log,
  signal,
}: {
  db: WorklingDatabase
  command: Command
  log: (message: string) => void
  signal: AbortSignal
}): Promise<void> {
  for (const repo of db.select().from(repos).all()) {
    if (signal.aborted) return
    if (!repo.enabled || repo.platform !== 'github') continue
    const rows = db.select().from(issues).where(eq(issues.repoId, repo.id)).all()
    if (!rows.length) continue
    try {
      const output = await command(
        [
          'gh',
          'pr',
          'list',
          '-R',
          repo.path,
          '--state',
          'all',
          '--search',
          'head:workling/',
          '--json',
          'number,url,headRefName,state,updatedAt',
          '--limit',
          '100',
        ],
        { env: ghEnv(repo.token, repo.host), signal },
      )
      if (signal.aborted) return
      const parsed: unknown = JSON.parse(output)
      if (!Value.Check(schema, parsed)) throw new Error('PR 列表格式无效')
      const best = new Map<number, (typeof parsed)[number]>()
      for (const pr of parsed) {
        const match = /^workling\/(\d+)-/.exec(pr.headRefName)
        if (!match) continue
        const number = Number(match[1])
        const previous = best.get(number)
        if (
          !previous ||
          (pr.state === 'OPEN' && previous.state !== 'OPEN') ||
          ((pr.state === 'OPEN') === (previous.state === 'OPEN') &&
            Date.parse(pr.updatedAt) > Date.parse(previous.updatedAt))
        )
          best.set(number, pr)
      }
      for (const issue of rows) {
        if (signal.aborted) return
        if (issue.status === 'running') continue
        if (
          issue.status === 'queued' &&
          !db
            .select({ id: feedback.id })
            .from(feedback)
            .where(and(eq(feedback.issueId, issue.id), eq(feedback.status, 'pending')))
            .get()
        )
          continue
        const pr = best.get(issue.number)
        if (!pr) continue
        const prState = pr.state.toLowerCase() as NonNullable<typeof issue.prState>
        if (issue.prUrl !== pr.url || issue.prState !== prState)
          db.update(issues).set({ prUrl: pr.url, prState }).where(eq(issues.id, issue.id)).run()
      }
    } catch (error) {
      if (signal.aborted) return
      log(`${repo.ref} PR 同步失败：${errorMessage(error)}`)
    }
  }
}
