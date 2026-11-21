import { desc, eq } from 'drizzle-orm'
import * as Value from 'typebox/value'
import { issues, repos, triageRecords } from '../db/schema.ts'
import type { WorklingDatabase } from '../db/index.ts'
import { triageSchema } from './triage-schema.ts'
import type { TriageData, TriageOverview } from './triage-schema.ts'
export { triageSchema, triageOverviewSchema } from './triage-schema.ts'

export function repoTriage(db: WorklingDatabase, repo: typeof repos.$inferSelect): TriageData {
  const issueMap = new Map(
    db
      .select()
      .from(issues)
      .where(eq(issues.repoId, repo.id))
      .all()
      .map((issue) => [issue.number, issue]),
  )
  const seen = new Set<number>()
  const rows = db
    .select()
    .from(triageRecords)
    .where(eq(triageRecords.repoId, repo.id))
    .orderBy(desc(triageRecords.triagedAt), desc(triageRecords.id))
    .all()
  const followUp = (row: typeof triageRecords.$inferSelect) => {
    if (!row.suggestedAt) return null
    if (
      rows.some(
        (other) =>
          other.number === row.number &&
          other.contentHash !== row.contentHash &&
          (other.triagedAt > row.suggestedAt! ||
            (other.triagedAt.getTime() === row.suggestedAt!.getTime() && other.id > row.id)),
      )
    )
      return 'edited' as const
    const issue = issueMap.get(row.number)
    if (issue && issue.createdAt > row.suggestedAt) return 'readyWithoutEdit' as const
    return 'pending' as const
  }
  const suggestions = { total: 0, edited: 0, readyWithoutEdit: 0, pending: 0 }
  for (const row of rows) {
    const follow = followUp(row)
    if (follow) {
      suggestions.total++
      suggestions[follow]++
    }
  }
  const records = rows
    .filter((row) => {
      if (seen.has(row.number)) return false
      seen.add(row.number)
      return true
    })
    .slice(0, 100)
    .map((row) => {
      const issue = issueMap.get(row.number)
      return {
        ...row,
        checks: JSON.parse(row.checks) as unknown,
        missing: JSON.parse(row.missing) as unknown,
        issueUpdatedAt: row.issueUpdatedAt.toISOString(),
        triagedAt: row.triagedAt.toISOString(),
        suggestedAt: row.suggestedAt?.toISOString() ?? null,
        labelRemovedAt: row.labelRemovedAt?.toISOString() ?? null,
        autoQueuedAt: row.autoQueuedAt?.toISOString() ?? null,
        followUp: followUp(row),
        readyAt: issue?.createdAt.toISOString() ?? null,
        readyAfterMinutes:
          issue && !row.alreadyReady
            ? Math.floor((issue.createdAt.getTime() - row.issueUpdatedAt.getTime()) / 60000)
            : null,
      }
    })
  const summary = {
    suggestions,
    total: 0,
    acceptReady: 0,
    acceptNotReady: 0,
    otherReady: 0,
    otherNotReady: 0,
  }
  // 列表展示最新尝试；最新尝试失败时，汇总沿用该 Issue 最近一次有结论的记录。
  for (const latest of records) {
    const row = rows.find((item) => item.number === latest.number && item.decision)
    if (!row || row.alreadyReady) continue
    summary.total++
    if (row.decision === 'accept') {
      if (latest.readyAt) summary.acceptReady++
      else summary.acceptNotReady++
    } else if (latest.readyAt) summary.otherReady++
    else summary.otherNotReady++
  }
  const response = { level: repo.triageLevel, summary, records }
  if (!Value.Check(triageSchema, response)) throw new Error('分诊数据无效')
  return response
}

export function triageOverview(db: WorklingDatabase): TriageOverview {
  const all = db
    .select()
    .from(repos)
    .all()
    .filter((r) => r.enabled || r.triageLevel !== 'off')
    .map((repo) => ({ repo, data: repoTriage(db, repo) }))
  const summary = {
    total: 0,
    acceptReady: 0,
    acceptNotReady: 0,
    otherReady: 0,
    otherNotReady: 0,
    suggestions: { total: 0, edited: 0, readyWithoutEdit: 0, pending: 0 },
  }
  for (const { data } of all) {
    for (const key of [
      'total',
      'acceptReady',
      'acceptNotReady',
      'otherReady',
      'otherNotReady',
    ] as const)
      summary[key] += data.summary[key]
    for (const key of ['total', 'edited', 'readyWithoutEdit', 'pending'] as const)
      summary.suggestions[key] += data.summary.suggestions[key]
  }
  const records = all
    .flatMap(({ repo, data }) => data.records.map((row) => ({ ...row, repoRef: repo.ref })))
    .sort((a, b) => b.triagedAt.localeCompare(a.triagedAt) || b.id - a.id)
    .slice(0, 200)
  return {
    repos: all.map(({ repo, data }) => ({
      id: repo.id,
      ref: repo.ref,
      platform: repo.platform,
      host: repo.host,
      path: repo.path,
      enabled: repo.enabled,
      level: data.level,
      summary: data.summary,
    })),
    summary,
    records,
    pendingSuggestions: records.filter((row) => row.followUp === 'pending').length,
  }
}
