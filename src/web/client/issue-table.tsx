import { Link, useLocation } from 'react-router'
import { labels, stages, type IssueRow } from '../issue-view.ts'
import { stageLabels, type Stage } from '../stage.ts'
import { PLATFORM_ICON_PATHS } from '../platform.ts'
import { relativeTime, prLabel, shortRef } from '../format.ts'
import type { IssueList } from './issue-list.ts'

export function IssueRef({ repoRef, number }: { repoRef: string; number: number }) {
  return (
    <span className="ref mono" title={`${repoRef} #${number}`}>
      {shortRef(repoRef, number)}
    </span>
  )
}

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
export function StageBadge({ stage, text }: { stage: Stage; text?: string }) {
  return (
    <span className={`badge badge--${stage}`}>
      <span className={`dot dot--${stage}`}></span>
      {text ?? stageLabels[stage]}
    </span>
  )
}
export function PR({
  url,
  state,
  variant = 'table',
}: {
  url: Issue['prUrl']
  state: Issue['prState']
  variant?: 'table' | 'detail'
}) {
  if (!url) return variant === 'detail' ? <span className="muted">暂无 PR</span> : <span>—</span>
  const link = (
    <>
      {url.startsWith('https://') ? (
        <a
          className={variant === 'detail' ? 'button' : undefined}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="查看 PR"
        >
          {variant === 'detail' ? '查看 PR ↗' : `PR ${prLabel(url)}`}
        </a>
      ) : (
        <span>{url}</span>
      )}{' '}
      {state && (
        <span className="pr-state">
          · {{ open: '打开中', merged: '已合并', closed: '已关闭' }[state]}
        </span>
      )}
    </>
  )
  return variant === 'detail' ? link : <span>{link}</span>
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
    <nav className="chips" aria-label="任务阶段">
      {stages.map((s) => {
        const params = new URLSearchParams(location.search)
        params.delete('status')
        params.set('stage', s)
        return (
          <Link
            key={s}
            className="chip"
            to={`${location.pathname}?${params}`}
            aria-current={selected === s ? 'page' : undefined}
          >
            {s === 'all' ? '全部' : s === 'attention' ? '需要处理' : stageLabels[s]}{' '}
            <span className={s === 'attention' && (counts[s] ?? 0) > 0 ? 'chip-alert' : undefined}>
              {counts[s] ?? 0}
            </span>
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
      <table className="issue-table">
        <thead>
          <tr>
            {['Issue', '阶段', '分支 / PR', '轮次', '更新'].map((title) => (
              <th key={title}>{title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((issue) => {
            const repo = repos.find((r) => r.id === issue.repoId)
            if (!repo) return null
            return (
              <tr key={issue.id}>
                <td>
                  <div className="issue-cell">
                    <IssueRef repoRef={repo.ref} number={issue.number} />
                    <Link className="issue-title" to={`/issues/${issue.id}`}>
                      {issue.title ?? <span className="muted">（未记录标题）</span>}
                    </Link>
                  </div>
                </td>
                <td>
                  <StageBadge
                    stage={issue.stage}
                    text={
                      issue.stage === 'queued' ? `排队 #${queuePosition.get(issue.id)}` : undefined
                    }
                  />
                </td>
                <td>
                  <div className="branch mono">{issue.branch ?? '—'}</div>
                  {issue.prUrl && (
                    <div className="pr-line">
                      <PR url={issue.prUrl} state={issue.prState} />
                    </div>
                  )}
                </td>
                <td className="num">{issue.rounds}</td>
                <td className="nowrap muted" title={issue.updatedAt.toLocaleString()}>
                  {relativeTime(issue.updatedAt, now)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!items.length && <p className="empty">没有符合条件的 Issue</p>}
    </div>
  )
}
