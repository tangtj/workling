import { formatDuration } from './format.ts'
export type IssueRow = {
  id: number
  repoId: number
  number: number
  title: string | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  updatedAt: Date
  runCount: number
  lastRun: {
    startedAt: Date
    endedAt: Date | null
    exitCode: number | null
    error: string | null
  } | null
}
export const labels = {
  running: '执行中',
  queued: '排队',
  failed: '失败',
  done: '完成',
  canceled: '已取消',
}
export function failureReason(issue: Pick<IssueRow, 'lastRun'>): { label: string; advice: string } {
  const run = issue.lastRun
  switch (run?.error) {
    case '超时':
      return { label: '超时', advice: '任务可能过大：拆分 Issue 或调大超时后重新打 workling:ready' }
    case '已取消':
      return { label: '已取消', advice: '确认需要后重新打 workling:ready' }
    case '进程丢失':
    case '进程中断':
      return { label: '进程丢失', advice: '通常是机器重启或进程被结束，直接重试即可' }
    case '内存不足（OOM）':
      return { label: '内存不足', advice: '调大执行器内存后重试' }
    case '未找到 PR':
      return { label: '未建 PR', advice: '查看 codex 回报中的阻塞原因，补充 Issue 描述后重试' }
  }
  if (run?.error) return { label: '失败', advice: run.error }
  if (run && run.exitCode !== null && run.exitCode !== 0)
    return { label: `退出码 ${run.exitCode}`, advice: '查看日志定位失败步骤' }
  return { label: '失败', advice: '查看日志定位原因' }
}

export const statuses = ['all', 'running', 'queued', 'failed', 'done', 'canceled'] as const
export const selectedStatus = (filter: string) => statuses.find((s) => s === filter) ?? 'all'
export const statusCounts = (items: IssueRow[]) =>
  Object.fromEntries(
    statuses.map((s) => [
      s,
      s === 'all' ? items.length : items.filter((i) => i.status === s).length,
    ]),
  )
export const queuePositions = (items: IssueRow[]) =>
  new Map(
    items
      .filter((i) => i.status === 'queued')
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .map((issue, index) => [issue.id, index + 1]),
  )
export const sortIssues = <T extends IssueRow>(items: T[]) =>
  [...items].sort(
    (a, b) =>
      Number(b.status === 'running') - Number(a.status === 'running') ||
      b.updatedAt.getTime() - a.updatedAt.getTime(),
  )

export function stageText(
  issue: IssueRow,
  now: number,
  queuePosition: Map<number, number>,
): string {
  const run = issue.lastRun
  return issue.status === 'queued'
    ? `队列第 ${queuePosition.get(issue.id)} 位`
    : !run
      ? '尚未执行'
      : issue.status === 'running'
        ? `已运行 ${formatDuration(now - run.startedAt.getTime())}`
        : issue.status === 'failed'
          ? failureReason(issue).label
          : issue.status === 'canceled'
            ? '已取消'
            : run.endedAt
              ? `用时 ${formatDuration(run.endedAt.getTime() - run.startedAt.getTime())}`
              : '尚未执行'
}
export function filterIssues<T extends IssueRow>(
  items: T[],
  repoId: number | undefined,
  q: string,
): T[] {
  const numberQuery = q.startsWith('#') || /^\d+$/.test(q)
  return items.filter(
    (i) =>
      (repoId === undefined || i.repoId === repoId) &&
      (!q ||
        (numberQuery
          ? /^#?\d+$/.test(q) && i.number === Number(q.replace(/^#/, ''))
          : (i.title ?? '').toLowerCase().includes(q.toLowerCase()))),
  )
}
