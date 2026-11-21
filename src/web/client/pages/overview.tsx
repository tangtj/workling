import { useEffect } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { formatDuration, formatTime, relativeTime } from '../../format.ts'
import { failureReason } from '../../issue-view.ts'
import { overviewModel, runResult, type OverviewIssue } from '../../overview-view.ts'
import { Badge, PR } from '../issue-table.tsx'
import { overviewOptions } from '../overview.ts'
import { usePageLayout } from '../layout.tsx'
import { useRefreshPaused } from '../refresh-pause.ts'

const Title = ({ issue }: { issue: OverviewIssue }) => (
  <>{issue.title ?? <span className="muted">（未记录标题）</span>}</>
)
const IssueLink = ({ issue }: { issue: OverviewIssue }) => (
  <Link to={`/issues/${issue.id}`} className="mono">
    {issue.repoRef} #{issue.number}
  </Link>
)
export function OverviewPage() {
  const page = useQuery(overviewOptions)
  const paused = useRefreshPaused()
  const { setActive } = usePageLayout()
  useEffect(() => {
    document.title = '概览 · Workling'
    setActive('overview')
  }, [setActive])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        !document.hidden &&
        !document.querySelector('dialog[open], [role="dialog"]:not([hidden])') &&
        !paused
      )
        void page.refetch()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [page.refetch, paused])
  if (!page.data && page.isPending) return <p className="muted">加载中…</p>
  if (!page.data)
    return (
      <p className="error-box" role="alert">
        加载页面失败{' '}
        <button className="button" type="button" onClick={() => void page.refetch()}>
          重试
        </button>
      </p>
    )
  const { issues, repos, now, concurrency, alerts, attention, reworked } = page.data
  const { running, queued, recent, meanMs, idle } = overviewModel(issues, now, concurrency)
  const date = new Date(now)
  return (
    <>
      {page.isRefetchError && (
        <p className="error-box" role="alert">
          加载页面失败{' '}
          <button className="button" type="button" onClick={() => void page.refetch()}>
            重试
          </button>
        </p>
      )}
      <header className="page-head">
        <div>
          <h1>概览</h1>
          <p>
            {date.getMonth() + 1} 月 {date.getDate()} 日 周{'日一二三四五六'[date.getDay()]} ·{' '}
            {repos.total} 个仓库，{repos.enabled} 个启用
          </p>
        </div>
        <div className="actions">
          <Link className="button" to="/issues">
            全部任务
          </Link>
          <Link className="button button--primary" to="/repos#add">
            添加仓库
          </Link>
        </div>
      </header>
      {alerts.map((alert) => (
        <div className="overview-alert" key={alert.kind} role="alert">
          <span className="badge badge--failed">系统</span>
          <span>{alert.message}</span>
          {alert.kind === 'worker' && (
            <button
              type="button"
              className="button"
              onClick={() => document.querySelector<HTMLButtonElement>('.version-pill')?.click()}
            >
              查看版本
            </button>
          )}
        </div>
      ))}
      <section className="card">
        <div className="card-head">
          <h2>需要你处理 {attention.length}</h2>
          <span className="muted">按等待时长排序，处理后自动消失</span>
        </div>
        {attention.map((item) => (
          <article className="attention-row" key={`${item.kind}-${item.repoId}-${item.number}`}>
            <span className={`badge badge--${item.kind === 'needs_info' ? 'info' : item.kind}`}>
              {
                {
                  failed: '执行失败',
                  capped: '返工到上限',
                  review: 'PR 待审',
                  needs_info: '信息不全',
                }[item.kind]
              }
            </span>
            <div className="attention-main">
              <div>
                <span className="mono">
                  {item.repoRef}#{item.number}
                </span>{' '}
                {item.title ?? '（未记录标题）'}
              </div>
              <div className="li-meta">
                {item.reason} · {relativeTime(new Date(item.since), now)}
              </div>
            </div>
            <div className="actions attention-actions">
              {item.kind === 'failed' && item.logRunId !== null && (
                <Link className="button" to={`/runs/${item.logRunId}/log`}>
                  看日志
                </Link>
              )}
              {(item.kind === 'capped' || item.kind === 'review') && item.prUrl && (
                <a className="button" href={item.prUrl} target="_blank" rel="noreferrer">
                  {item.kind === 'capped' ? '打开 PR' : '去 review'}
                </a>
              )}
              {(item.kind === 'failed' || item.kind === 'capped') && item.issueId !== null && (
                <Link className="button" to={`/issues/${item.issueId}`}>
                  打开
                </Link>
              )}
              {item.kind === 'needs_info' && (
                <Link className="button" to={`/triage?repo=${item.repoId}`}>
                  看分诊
                </Link>
              )}
            </div>
          </article>
        ))}
        {!attention.length && <p className="empty">没有要处理的事</p>}
      </section>
      <section className="card overview-slots">
        <div className="card-head">
          <h2>
            执行中 {running.length} / {concurrency}
          </h2>
        </div>
        <div className="slots">
          {running.map((issue) => {
            const run = issue.lastRun
            return (
              <article className="slot" key={issue.id}>
                <div className="slot-top">
                  <span className={`badge badge--${run?.kind === 'rework' ? 'rework' : 'running'}`}>
                    {run?.kind === 'rework' ? '返工' : '实现'} · 第 {issue.round} 轮
                  </span>
                  {run && (
                    <span>已运行 {formatDuration(Math.max(0, now - run.startedAt.getTime()))}</span>
                  )}
                </div>
                <Link className="slot-title" to={`/issues/${issue.id}`}>
                  <span className="mono">
                    {issue.repoRef}#{issue.number}
                  </span>{' '}
                  <Title issue={issue} />
                </Link>
                {run && (
                  <div className="slot-foot">
                    <Link to={`/runs/${run.id}/log`}>实时日志</Link>
                  </div>
                )}
              </article>
            )
          })}
          {Array.from({ length: idle }, (_, index) => (
            <article className="slot idle" key={index}>
              空闲名额
            </article>
          ))}
        </div>
      </section>
      <div className="grid g-2">
        <section className="card">
          <div className="card-head">
            <h2>排队 {queued.length}</h2>
          </div>
          <div className="list">
            {queued.map((issue, index) => (
              <article key={issue.id} className="li">
                <span className={`qnum${index === 0 ? ' next' : ''}`}>{index + 1}</span>
                <div className="li-main">
                  <Link className="li-title" to={`/issues/${issue.id}`}>
                    <Title issue={issue} />
                  </Link>
                  <div className="li-meta">
                    {issue.repoRef} #{issue.number} · {relativeTime(issue.updatedAt, now)}入队
                    {index === 0 && ' · 下一个拉起'}
                  </div>
                </div>
              </article>
            ))}
            {!queued.length && <p className="empty">队列为空</p>}
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <h2>最近 24 小时</h2>
          </div>
          <div className="kpis">
            {[
              ['完成数', recent.filter(({ run }) => runResult(run) === 'done').length],
              ['返工', reworked],
              ['失败数', recent.filter(({ run }) => runResult(run) === 'failed').length],
              ['平均用时', meanMs === null ? '—' : formatDuration(meanMs)],
            ].map(([label, value]) => (
              <div key={label} className="kpi">
                <span>{label}</span>
                <strong className={label === '失败数' ? 'overview-failed' : undefined}>
                  {value}
                </strong>
              </div>
            ))}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {['结束时间', 'Issue', '结果', '用时', 'PR'].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.slice(0, 10).map(({ issue, run }) => (
                  <tr key={run.id}>
                    <td>{formatTime(run.endedAt!, now)}</td>
                    <td>
                      <div className="issue-cell">
                        <IssueLink issue={issue} />
                        <Title issue={issue} />
                      </div>
                    </td>
                    <td>
                      <Badge
                        status={runResult(run)}
                        text={
                          runResult(run) === 'failed' && run.id === issue.lastRun?.id
                            ? failureReason(issue).label
                            : undefined
                        }
                      />
                    </td>
                    <td>{formatDuration(run.endedAt!.getTime() - run.startedAt.getTime())}</td>
                    <td>
                      <PR url={issue.prUrl} state={issue.prState} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!recent.length && <p className="empty">最近 24 小时没有执行记录</p>}
          </div>
        </section>
      </div>
    </>
  )
}
