import type { Issue, Run } from '../data.ts'
import { githubUrl } from '../data.ts'
import { formatDuration, formatTime, prLabel } from './format.ts'

export const labels = {
  running: '执行中',
  queued: '排队',
  failed: '失败',
  done: '完成',
  canceled: '已取消',
}
export const Badge = ({ status, text }: { status: keyof typeof labels; text?: string }) => (
  <span class={`badge badge--${status}`}>
    <span class={`dot dot--${status}`}></span>
    {text ?? labels[status]}
  </span>
)
export const Title = ({ issue }: { issue: Issue }) => (
  <>{issue.title ?? <span class="muted">（未记录标题）</span>}</>
)
export const PRState = ({ state }: { state: Issue['prState'] }) =>
  state ? (
    <span class={`badge badge--pr-${state}`}>
      {{ open: '打开中', merged: '已合并', closed: '已关闭' }[state]}
    </span>
  ) : null
export const PR = ({ url, state }: { url: string | null; state: Issue['prState'] }) =>
  !url ? (
    <span>—</span>
  ) : (
    <span>
      {url.startsWith('https://') ? (
        <a href={url} rel="noreferrer">
          {prLabel(url)}
        </a>
      ) : (
        <span>{url}</span>
      )}{' '}
      <PRState state={state} />
    </span>
  )
export const result = (run: Run): keyof typeof labels =>
  !run.endedAt ? 'running' : run.exitCode === 0 && !run.error ? 'done' : 'failed'
export const resultText = (run: Run) => (run.error === '进程中断' ? '中断' : labels[result(run)])
export const count = (items: Issue[], status: Issue['status']) =>
  items.filter((i) => i.status === status).length
export const summary = (items: Issue[]) =>
  (['running', 'queued', 'failed'] as const)
    .map((s) => (count(items, s) ? `${count(items, s)} ${labels[s]}` : ''))
    .filter(Boolean)
    .join(' · ') || '暂无 Issue'
export const IssueLink = ({ issue }: { issue: Issue }) => (
  <a href={`/issues/${issue.id}`} class="mono">
    {issue.repo.ref} #{issue.number}
  </a>
)
export const Stats = ({ items }: { items: Issue[] }) => (
  <div class="stats">
    {(['running', 'queued', 'failed', 'done'] as const).map((s) => (
      <div class="card stat">
        <span class="muted">{labels[s]}</span>
        <strong>{count(items, s)}</strong>
      </div>
    ))}
  </div>
)

export function failureReason(issue: Issue): { label: string; advice: string } {
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
export const statusCounts = (items: Issue[]) =>
  Object.fromEntries(statuses.map((s) => [s, s === 'all' ? items.length : count(items, s)]))
export const queuePositions = (items: Issue[]) =>
  new Map(
    items
      .filter((i) => i.status === 'queued')
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .map((issue, index) => [issue.id, index + 1]),
  )
export const sortIssues = (items: Issue[]) =>
  [...items].sort(
    (a, b) =>
      Number(b.status === 'running') - Number(a.status === 'running') ||
      b.updatedAt.getTime() - a.updatedAt.getTime(),
  )

export function StatusChips({
  base,
  selected,
  counts,
}: {
  base: string
  selected: string
  counts: Record<string, number>
}) {
  const url = new URL(base, 'http://localhost')
  return (
    <nav class="chips" aria-label="任务状态">
      {statuses.map((s) => {
        url.searchParams.set('status', s)
        return (
          <a
            class="chip"
            href={`${url.pathname}${url.search}`}
            aria-current={selected === s ? 'page' : undefined}
          >
            {s === 'all' ? '全部' : labels[s]} <span>{counts[s] ?? 0}</span>
          </a>
        )
      })}
    </nav>
  )
}

export function IssueTable({
  items,
  now,
  emptyText,
  queuePosition,
}: {
  items: Issue[]
  now: number
  emptyText: string
  queuePosition: Map<number, number>
}) {
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            {['Issue', '状态', '阶段/结果', '次数', 'PR', '更新'].map((title) => (
              <th>{title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((issue) => {
            const run = issue.lastRun
            const stage =
              issue.status === 'queued'
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
            return (
              <tr>
                <td>
                  <div class="issue-cell">
                    <span class="ref mono">
                      {issue.repo.ref} #{issue.number}
                    </span>
                    <div>
                      <a href={`/issues/${issue.id}`}>
                        <Title issue={issue} />
                      </a>{' '}
                      <a href={githubUrl(issue)} rel="noreferrer">
                        GitHub ↗
                      </a>
                    </div>
                  </div>
                </td>
                <td>
                  <Badge status={issue.status} />
                </td>
                <td>{issue.status === 'failed' ? <span class="reason">{stage}</span> : stage}</td>
                <td>{issue.runs.length}</td>
                <td>
                  <PR url={issue.prUrl} state={issue.prState} />
                </td>
                <td>{formatTime(issue.updatedAt, now)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!items.length && <p class="empty">{emptyText}</p>}
    </div>
  )
}
