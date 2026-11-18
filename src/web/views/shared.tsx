import type { Issue, Run } from '../data.ts'
import { githubUrl } from '../data.ts'
import { formatTime, prLabel } from './format.ts'

import { PLATFORM_ICON_PATHS, platformName } from '../platform.ts'
import {
  labels,
  statuses,
  selectedStatus,
  statusCounts,
  queuePositions,
  sortIssues,
  failureReason,
  stageText,
} from '../issue-view.ts'
export {
  platformName,
  labels,
  statuses,
  selectedStatus,
  statusCounts,
  queuePositions,
  sortIssues,
  failureReason,
}

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
            const stage = stageText({ ...issue, runCount: issue.runs.length }, now, queuePosition)
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
