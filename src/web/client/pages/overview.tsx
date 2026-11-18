import { useEffect } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { formatDuration, formatTime, secondsAgo, relativeTime } from '../../views/format.ts'
import { failureReason } from '../../issue-view.ts'
import { overviewModel, slotTiming, runResult, type OverviewIssue } from '../../overview-view.ts'
import { Badge, PR } from '../issue-table.tsx'
import { overviewOptions } from '../overview.ts'
import { usePageLayout } from '../layout.tsx'

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
        document.body.dataset.refreshPaused !== 'true'
      )
        void page.refetch()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [page.refetch])
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
  const { issues, repos, now, watch: status, concurrency } = page.data
  const { running, queued, failed, recent, meanMs, idle } = overviewModel(issues, now, concurrency)
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
      <div className={`health${status?.lastPollError ? ' warn' : ''}`}>
        {status ? (
          <>
            <span>
              <span className="dot dot--done"></span> <b>watch 运行中</b>
            </span>
            <span className="mono">{status.worker}</span>
            <span>上次轮询 {status.lastPollAt ? secondsAgo(status.lastPollAt, now) : '—'}</span>
            <span>
              并发 {running.length} / {concurrency} · 超时 {status.timeout} 分钟
            </span>
            {status.lastPollError && <span>{status.lastPollError}</span>}
          </>
        ) : (
          <span>
            <span className="dot"></span> watch 状态未知
          </span>
        )}
      </div>
      <h2>执行名额</h2>
      <div className="slots">
        {running.map((issue) => {
          const run = issue.lastRun
          const {
            elapsedSeconds: elapsed,
            limitSeconds: limit,
            hot,
            remainingMinutes,
          } = slotTiming(run?.startedAt ?? new Date(now), now, status?.timeout ?? null)
          return (
            <article key={issue.id} className="slot">
              <div className="slot-top">
                <span className="mono">
                  {issue.repoRef} #{issue.number}
                </span>
                <Badge status="running" />
              </div>
              <Link className="slot-title" to={`/issues/${issue.id}`}>
                <Title issue={issue} />
              </Link>
              {run && (
                <>
                  {limit !== null && (
                    <>
                      <div className="phase-label">
                        <span>已用 {formatDuration(elapsed * 1000)}</span>
                        <span>
                          {hot ? `剩余 ${remainingMinutes} 分钟` : `超时 ${status!.timeout} 分钟`}
                        </span>
                      </div>
                      <progress
                        className={`timebar${hot ? ' hot' : ''}`}
                        max={limit}
                        value={elapsed}
                        aria-label="已用执行时间"
                      />
                    </>
                  )}
                  <div className="slot-foot">
                    <span>
                      第 {issue.runCount} 次 · {run.startedAt.toTimeString().slice(0, 5)} 开始
                    </span>
                    <Link to={`/runs/${run.id}/log`}>实时日志</Link>
                  </div>
                </>
              )}
            </article>
          )
        })}
        {Array.from({ length: idle }, (_, index) => (
          <article key={index} className="slot idle">
            <span>空闲名额</span>
            {queued[0] && (
              <span>
                下一个：
                <Title issue={queued[0]} />
              </span>
            )}
          </article>
        ))}
        {!running.length && !idle && <p className="empty">当前没有执行中的任务</p>}
      </div>
      <div className="grid g-2">
        <section className="card">
          <div className="card-head">
            <h2>需要处理 {failed.length}</h2>
          </div>
          <div className="list">
            {failed.slice(0, 5).map((issue) => (
              <article key={issue.id} className="li">
                <div className="li-main">
                  <div className="row between">
                    <IssueLink issue={issue} />
                    <Badge status="failed" text={failureReason(issue).label} />
                  </div>
                  <div className="li-title">
                    <Title issue={issue} />
                  </div>
                  <div className="li-meta">
                    {formatTime(issue.updatedAt, now)} · 第 {issue.runCount} 次
                  </div>
                  <div className="advice">{failureReason(issue).advice}</div>
                  {issue.lastRun && <Link to={`/runs/${issue.lastRun.id}/log`}>查看日志</Link>}
                </div>
              </article>
            ))}
            {!failed.length && <p className="empty">没有失败的任务</p>}
          </div>
          {failed.length > 5 && (
            <div className="card-body">
              <Link to="/issues?status=failed">查看全部失败</Link>
            </div>
          )}
        </section>
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
      </div>
      <section className="card">
        <div className="card-head">
          <h2>最近 24 小时</h2>
        </div>
        <div className="kpis">
          {[
            ['完成数', recent.filter(({ run }) => runResult(run) === 'done').length],
            ['失败数', recent.filter(({ run }) => runResult(run) === 'failed').length],
            ['平均用时', meanMs === null ? '—' : formatDuration(meanMs)],
          ].map(([label, value]) => (
            <div key={label} className="kpi">
              <span>{label}</span>
              <strong>{value}</strong>
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
    </>
  )
}
