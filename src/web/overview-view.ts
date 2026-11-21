import type { IssueRow } from './issue-view.ts'

export type OverviewRun = {
  id: number
  kind?: 'implement' | 'rework'
  startedAt: Date
  endedAt: Date | null
  exitCode: number | null
  error: string | null
}
export type OverviewIssue = IssueRow & {
  repoRef: string
  runs: OverviewRun[]
  lastRun: OverviewRun | null
}
export const runResult = (run: OverviewRun): 'running' | 'done' | 'failed' =>
  !run.endedAt ? 'running' : run.exitCode === 0 && !run.error ? 'done' : 'failed'
export function overviewModel<T extends OverviewIssue>(
  issues: T[],
  now: number,
  concurrency: number,
) {
  const running = issues
    .filter((i) => i.status === 'running')
    .sort((a, b) => (a.lastRun?.startedAt.getTime() ?? 0) - (b.lastRun?.startedAt.getTime() ?? 0))
  const queued = issues
    .filter((i) => i.status === 'queued')
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
  const failed = issues
    .filter((i) => i.status === 'failed')
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const recent = issues
    .flatMap((issue) =>
      issue.runs
        .filter(
          (r) => r.endedAt && r.endedAt.getTime() >= now - 86400000 && r.endedAt.getTime() <= now,
        )
        .map((run) => ({ issue, run })),
    )
    .sort((a, b) => b.run.endedAt!.getTime() - a.run.endedAt!.getTime())
  const meanMs = recent.length
    ? recent.reduce((sum, { run }) => sum + run.endedAt!.getTime() - run.startedAt.getTime(), 0) /
      recent.length
    : null
  return {
    running,
    queued,
    failed,
    recent,
    meanMs,
    idle: Math.max(0, concurrency - running.length),
  }
}
export function slotTiming(startedAt: Date, now: number, timeoutMinutes: number | null) {
  const elapsedSeconds = Math.max(0, (now - startedAt.getTime()) / 1000)
  const limitSeconds = timeoutMinutes === null ? null : timeoutMinutes * 60
  return {
    elapsedSeconds,
    limitSeconds,
    hot: limitSeconds !== null && limitSeconds - elapsedSeconds < limitSeconds * 0.2,
    remainingMinutes:
      limitSeconds === null ? null : Math.max(0, Math.ceil((limitSeconds - elapsedSeconds) / 60)),
  }
}
