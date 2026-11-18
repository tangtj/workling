import { Link, useLocation } from 'react-router'
import { labels, statuses, stageText, type IssueRow } from '../issue-view.ts'
import { PLATFORM_ICON_PATHS, platformName } from '../platform.ts'
import { formatTime, prLabel } from '../views/format.ts'
import type { IssueList } from './issue-list.ts'

type Issue = IssueList['issues'][number]
type Repo = IssueList['repos'][number]
export function PlatformIcon({ platform }: { platform: Repo['platform'] }) {
  return (
    <svg
      className="platform-icon"
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
export function Badge({ status, text }: { status: IssueRow['status']; text?: string }) {
  return (
    <span className={`badge badge--${status}`}>
      <span className={`dot dot--${status}`}></span>
      {text ?? labels[status]}
    </span>
  )
}
export function PR({ url, state }: { url: Issue['prUrl']; state: Issue['prState'] }) {
  return !url ? (
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
      {state && (
        <span className={`badge badge--pr-${state}`}>
          {{ open: '打开中', merged: '已合并', closed: '已关闭' }[state]}
        </span>
      )}
    </span>
  )
}
export function StatusChips({
  selected,
  counts,
}: {
  selected: string
  counts: Record<string, number>
}) {
  const location = useLocation()
  return (
    <nav className="chips" aria-label="任务状态">
      {statuses.map((s) => {
        const params = new URLSearchParams(location.search)
        params.set('status', s)
        return (
          <Link
            key={s}
            className="chip"
            to={`${location.pathname}?${params}`}
            aria-current={selected === s ? 'page' : undefined}
          >
            {s === 'all' ? '全部' : labels[s]} <span>{counts[s] ?? 0}</span>
          </Link>
        )
      })}
    </nav>
  )
}
export function IssueTable({
  items,
  repos,
  now,
  queuePosition,
}: {
  items: Issue[]
  repos: Repo[]
  now: number
  queuePosition: Map<number, number>
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {['Issue', '状态', '阶段/结果', '次数', 'PR', '更新'].map((title) => (
              <th key={title}>{title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((issue) => {
            const repo = repos.find((r) => r.id === issue.repoId)
            if (!repo) return null
            const stage = stageText(issue, now, queuePosition)
            return (
              <tr key={issue.id}>
                <td>
                  <div className="issue-cell">
                    <span className="ref mono">
                      {repo.ref} #{issue.number}
                    </span>
                    <div>
                      <Link to={`/issues/${issue.id}`}>
                        {issue.title ?? <span className="muted">（未记录标题）</span>}
                      </Link>{' '}
                      <a
                        href={`https://${repo.host}/${repo.path}/issues/${issue.number}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`在 ${platformName[repo.platform]} 打开`}
                        title={`在 ${platformName[repo.platform]} 打开`}
                      >
                        <PlatformIcon platform={repo.platform} />
                      </a>
                    </div>
                  </div>
                </td>
                <td>
                  <Badge status={issue.status} />
                </td>
                <td>
                  {issue.status === 'failed' ? <span className="reason">{stage}</span> : stage}
                </td>
                <td>{issue.runCount}</td>
                <td>
                  <PR url={issue.prUrl} state={issue.prState} />
                </td>
                <td>{formatTime(issue.updatedAt, now)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!items.length && <p className="empty">没有符合条件的 Issue</p>}
    </div>
  )
}
