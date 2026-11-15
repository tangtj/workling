import type { PageData } from '../data.ts'
import { formatDuration, formatTime, secondsAgo, relativeTime } from './format.ts'
import { Badge, Title, PR, result, IssueLink, failureReason } from './shared.tsx'

export function OverviewPage({ data }: { data: PageData }) {
  const { issues, repos, now, status, concurrency } = data
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
  const mean = recent.length
    ? recent.reduce((sum, { run }) => sum + run.endedAt!.getTime() - run.startedAt.getTime(), 0) /
      recent.length
    : null
  const date = new Date(now)
  const idle = Math.max(0, concurrency - running.length)
  return (
    <>
      <header class="page-head">
        <div>
          <h1>概览</h1>
          <p>
            {date.getMonth() + 1} 月 {date.getDate()} 日 周{'日一二三四五六'[date.getDay()]} ·{' '}
            {repos.length} 个仓库，{repos.filter((r) => r.enabled).length} 个启用
          </p>
        </div>
        <div class="actions">
          <a class="button" href="/issues">
            全部任务
          </a>
          <a class="button button--primary" href="/repos#add">
            添加仓库
          </a>
        </div>
      </header>
      <div class={`health${status?.lastPollError ? ' warn' : ''}`}>
        {status ? (
          <>
            <span>
              <span class="dot dot--done"></span> <b>watch 运行中</b>
            </span>
            <span class="mono">{status.worker}</span>
            <span>上次轮询 {status.lastPollAt ? secondsAgo(status.lastPollAt, now) : '—'}</span>
            <span>
              并发 {running.length} / {concurrency} · 超时 {status.timeout} 分钟
            </span>
            {status.lastPollError && <span>{status.lastPollError}</span>}
          </>
        ) : (
          <span>
            <span class="dot"></span> watch 状态未知
          </span>
        )}
      </div>
      <h2>执行名额</h2>
      <div class="slots">
        {running.map((issue) => {
          const run = issue.lastRun
          const elapsed = run ? Math.max(0, (now - run.startedAt.getTime()) / 1000) : 0
          const limit = status ? status.timeout * 60 : null
          const hot = limit !== null && limit - elapsed < limit * 0.2
          return (
            <article class="slot">
              <div class="slot-top">
                <span class="mono">
                  {issue.repo.ref} #{issue.number}
                </span>
                <Badge status="running" />
              </div>
              <a class="slot-title" href={`/issues/${issue.id}`}>
                <Title issue={issue} />
              </a>
              {run && (
                <>
                  {limit !== null && (
                    <>
                      <div class="phase-label">
                        <span>已用 {formatDuration(elapsed * 1000)}</span>
                        <span>
                          {hot
                            ? `剩余 ${Math.max(0, Math.ceil((limit - elapsed) / 60))} 分钟`
                            : `超时 ${status!.timeout} 分钟`}
                        </span>
                      </div>
                      <progress
                        class={`timebar${hot ? ' hot' : ''}`}
                        max={limit}
                        value={elapsed}
                        aria-label="已用执行时间"
                      />
                    </>
                  )}
                  <div class="slot-foot">
                    <span>
                      第 {issue.runs.length} 次 · {run.startedAt.toTimeString().slice(0, 5)} 开始
                    </span>
                    <a href={`/runs/${run.id}/log`}>实时日志</a>
                  </div>
                </>
              )}
            </article>
          )
        })}
        {Array.from({ length: idle }, () => (
          <article class="slot idle">
            <span>空闲名额</span>
            {queued[0] && (
              <span>
                下一个：
                <Title issue={queued[0]} />
              </span>
            )}
          </article>
        ))}
        {!running.length && !idle && <p class="empty">当前没有执行中的任务</p>}
      </div>
      <div class="grid g-2">
        <section class="card">
          <div class="card-head">
            <h2>需要处理 {failed.length}</h2>
          </div>
          <div class="list">
            {failed.slice(0, 5).map((issue) => (
              <article class="li">
                <div class="li-main">
                  <div class="row between">
                    <IssueLink issue={issue} />
                    <Badge status="failed" text={failureReason(issue).label} />
                  </div>
                  <div class="li-title">
                    <Title issue={issue} />
                  </div>
                  <div class="li-meta">
                    {formatTime(issue.updatedAt, now)} · 第 {issue.runs.length} 次
                  </div>
                  <div class="advice">{failureReason(issue).advice}</div>
                  {issue.lastRun && <a href={`/runs/${issue.lastRun.id}/log`}>查看日志</a>}
                </div>
              </article>
            ))}
            {!failed.length && <p class="empty">没有失败的任务</p>}
          </div>
          {failed.length > 5 && (
            <div class="card-body">
              <a href="/issues?status=failed">查看全部失败</a>
            </div>
          )}
        </section>
        <section class="card">
          <div class="card-head">
            <h2>排队 {queued.length}</h2>
          </div>
          <div class="list">
            {queued.map((issue, index) => (
              <article class="li">
                <span class={`qnum${index === 0 ? ' next' : ''}`}>{index + 1}</span>
                <div class="li-main">
                  <a class="li-title" href={`/issues/${issue.id}`}>
                    <Title issue={issue} />
                  </a>
                  <div class="li-meta">
                    {issue.repo.ref} #{issue.number} · {relativeTime(issue.updatedAt, now)}入队
                    {index === 0 && ' · 下一个拉起'}
                  </div>
                </div>
              </article>
            ))}
            {!queued.length && <p class="empty">队列为空</p>}
          </div>
        </section>
      </div>
      <section class="card">
        <div class="card-head">
          <h2>最近 24 小时</h2>
        </div>
        <div class="kpis">
          {[
            ['完成数', recent.filter(({ run }) => result(run) === 'done').length],
            ['失败数', recent.filter(({ run }) => result(run) === 'failed').length],
            ['平均用时', mean === null ? '—' : formatDuration(mean)],
          ].map(([label, value]) => (
            <div class="kpi">
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                {['结束时间', 'Issue', '结果', '用时', 'PR'].map((label) => (
                  <th>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 10).map(({ issue, run }) => (
                <tr>
                  <td>{formatTime(run.endedAt!, now)}</td>
                  <td>
                    <div class="issue-cell">
                      <IssueLink issue={issue} />
                      <Title issue={issue} />
                    </div>
                  </td>
                  <td>
                    <Badge
                      status={result(run)}
                      text={
                        result(run) === 'failed' && run.id === issue.lastRun?.id
                          ? failureReason(issue).label
                          : undefined
                      }
                    />
                  </td>
                  <td>{formatDuration(run.endedAt!.getTime() - run.startedAt.getTime())}</td>
                  <td>
                    <PR url={issue.prUrl} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!recent.length && <p class="empty">最近 24 小时没有执行记录</p>}
        </div>
      </section>
    </>
  )
}
