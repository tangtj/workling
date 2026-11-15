import type { Issue, Run } from '../data.ts'
import { githubUrl } from '../data.ts'
import { formatDuration, formatTime, prLabel } from './format.ts'

const PLATFORM_ICON_PATHS = {
  github:
    'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3.165.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  gitlab:
    'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z',
} as const

export const platformName = { github: 'GitHub', gitlab: 'GitLab' } as const

export function PlatformIcon({ platform }: { platform: 'github' | 'gitlab' }) {
  return (
    <svg
      class="platform-icon"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PLATFORM_ICON_PATHS[platform]} />
    </svg>
  )
}

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
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label="查看 PR">
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
                      <a
                        href={githubUrl(issue)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`在 ${platformName[issue.repo.platform]} 打开`}
                        title={`在 ${platformName[issue.repo.platform]} 打开`}
                      >
                        <PlatformIcon platform={issue.repo.platform} />
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
