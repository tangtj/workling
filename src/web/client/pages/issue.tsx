import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { runResult } from '../../overview-view.ts'
import { platformName } from '../../platform.ts'
import { formatDuration, formatTime, relativeTime, prLabel } from '../../format.ts'
import { issueDetailOptions, parseDetailId } from '../issue-detail.ts'
import { Badge, PlatformIcon, PR, StageBadge } from '../issue-table.tsx'
import { shellKey, usePageLayout } from '../layout.tsx'
import { NotFound } from '../not-found.tsx'
import { loadFeedback } from '../feedback.ts'
import { RunTimeline } from '../run-timeline.tsx'

type Detail = NonNullable<Awaited<ReturnType<ReturnType<typeof issueDetailOptions>['queryFn']>>>

function CopyPath({ path }: { path: string }) {
  const [copiedAt, setCopiedAt] = useState<number | null>(null)
  useEffect(() => {
    if (copiedAt === null) return
    const timer = setTimeout(() => setCopiedAt(null), Math.max(0, copiedAt + 2000 - Date.now()))
    return () => clearTimeout(timer)
  }, [copiedAt])

  async function copy() {
    try {
      await navigator.clipboard.writeText(path)
      setCopiedAt(Date.now())
    } catch {
      // Leave the path visible for manual copying if clipboard access is denied.
    }
  }

  return (
    <button className="button" type="button" onClick={() => void copy()}>
      {copiedAt === null ? '复制路径' : '已复制'}
    </button>
  )
}

function RunCard({
  run,
  attempt,
  now,
  defaultOpen,
  onFinished,
}: {
  run: Detail['runs'][number]
  attempt: number
  now: number
  defaultOpen: boolean
  onFinished: () => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const status = runResult(run)
  return (
    <div className="run-card">
      <div className="row between">
        <div className="row">
          <strong>
            第 {attempt} 轮 · {run.kind === 'rework' ? '返工' : '实现'}
          </strong>
          <Badge status={status} text={run.error === '进程中断' ? '中断' : undefined} />
          {run.reportResult && <span>codex：{run.reportResult}</span>}
        </div>
        <span className="muted">{run.worker}</span>
      </div>
      <div className="run-details">
        <div>
          <small>开始</small>
          {run.kind === 'rework' ? '返工' : '实现'} · {formatTime(run.startedAt, now)}
        </div>
        <div>
          <small>结束</small>
          {run.endedAt ? formatTime(run.endedAt, now) : '—'}
        </div>
        <div>
          <small>用时</small>
          {formatDuration((run.endedAt?.getTime() ?? now) - run.startedAt.getTime())}
        </div>
        <div>
          <small>退出码</small>
          {run.exitCode ?? '—'}
        </div>
      </div>
      {run.error && <div className="error-box">{run.error}</div>}
      {run.summary && (
        <details>
          <summary>Pi 结论</summary>
          <pre>{run.summary}</pre>
        </details>
      )}
      <details
        className="run-process"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>执行过程</summary>
        <RunTimeline
          variant="compact"
          runId={run.id}
          ended={run.endedAt !== null}
          status={status}
          enabled={open}
          logTail={run.logTail}
          onFinished={onFinished}
        />
        <Link to={`/runs/${run.id}/log`}>查看完整时间线</Link>
      </details>
      <div className="item row">
        <span className="muted">任务目录</span>
        <code className="path">{run.taskDir ?? '—'}</code>
        <Link to={`/runs/${run.id}/log`}>完整时间线</Link>
        {run.taskDir && <CopyPath path={run.taskDir} />}
      </div>
    </div>
  )
}

const feedbackSources: Record<string, string> = {
  issue_comment: 'Issue 评论',
  pr_comment: 'PR 评论',
  review_comment: '行内评论',
  review: 'Review',
}
const feedbackTrust: Record<string, string> = {
  self: 'workling 自身',
  bot: 'Bot',
  allowlist: '受信账号',
  write: '写权限',
  untrusted: '不可信',
}

export function IssuePage() {
  const issueId = parseDetailId(useParams().id)
  const options = issueDetailOptions(issueId)
  const page = useQuery(options)
  const queryClient = useQueryClient()
  const { setActive } = usePageLayout()
  const data = page.data
  const [filter, setFilter] = useState<'all' | 'runs' | 'commands'>('all')
  const feedback = useQuery({
    queryKey: ['feedback', issueId],
    queryFn: ({ signal }) => loadFeedback(issueId!, signal),
    enabled: issueId !== undefined,
  })

  useEffect(() => {
    if (data) {
      document.title = 'Issue 详情 · Workling'
      setActive('issues')
    }
  }, [Boolean(data), setActive])

  const onFinished = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: issueDetailOptions(issueId).queryKey })
    void queryClient.invalidateQueries({ queryKey: shellKey })
    void queryClient.invalidateQueries({ queryKey: ['feedback', issueId] })
  }, [queryClient, issueId])

  const error = page.isError && (
    <p className="error-box" role="alert">
      加载页面失败{' '}
      <button className="button" type="button" onClick={() => void page.refetch()}>
        重试
      </button>
    </p>
  )
  if (!data && page.isPending) return <p className="muted">加载中…</p>
  if (!data) return error || <NotFound />

  const { issue, runs, now, triage, rework } = data
  const platform = platformName[issue.repo.platform]
  const items = feedback.data ?? []
  const rounds = new Map(runs.map((run, index) => [run.id, runs.length - index]))
  const events = [
    { type: 'queued' as const, time: issue.createdAt.getTime(), id: issue.id },
    ...triage.map((item) => ({
      type: 'triage' as const,
      time: new Date(item.triagedAt).getTime(),
      id: item.id,
      item,
    })),
    ...runs.map((item) => ({
      type: 'run' as const,
      time: item.startedAt.getTime(),
      id: item.id,
      item,
    })),
    ...items.map((item) => ({
      type: 'feedback' as const,
      time: new Date(item.createdAt).getTime(),
      id: item.id,
      item,
    })),
  ].sort((a, b) => a.time - b.time || a.id - b.id)
  const commands = items.filter((item) => item.isCommand)
  const latest = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const duration = runs.reduce(
    (sum, run) => sum + Math.max(0, (run.endedAt?.getTime() ?? now) - run.startedAt.getTime()),
    0,
  )
  const prState = issue.prState
    ? { open: '打开中', merged: '已合并', closed: '已关闭' }[issue.prState]
    : '状态未知'
  return (
    <>
      {error}
      <nav className="breadcrumbs">
        <Link to="/repos">仓库</Link> / <Link to={`/repos/${issue.repoId}`}>{issue.repo.ref}</Link>{' '}
        / #{issue.number}
      </nav>
      <section className="card issue-header">
        <div className="row between">
          <div className="issue-header-main">
            <div className="row">
              <strong className="mono">#{issue.number}</strong>{' '}
              <StageBadge
                stage={issue.stage}
                text={
                  issue.stage === 'running' || issue.stage === 'rework'
                    ? `${issue.stage === 'running' ? '执行中' : '返工中'} · 第 ${runs.length} 轮`
                    : undefined
                }
              />{' '}
              {issue.prUrl && (
                <span className="badge badge--review">
                  PR {prLabel(issue.prUrl)} · {prState}
                </span>
              )}
            </div>
            <h1>{issue.title ?? <span className="muted">（未记录标题）</span>}</h1>
            <p className="muted">
              {issue.branch && (
                <>
                  分支 <code>{issue.branch}</code> ·{' '}
                </>
              )}
              {issue.baseRef && (
                <>
                  基于 <code>{issue.baseRef}</code> ·{' '}
                </>
              )}
              首次入队 {formatTime(issue.createdAt, now)} · 共 {runs.length} 轮
              {runs.length > 0 && <> · 累计 {formatDuration(duration)}</>}
            </p>
          </div>
          <div className="row">
            <a
              className="button"
              href={`https://${issue.repo.host}/${issue.repo.path}/issues/${issue.number}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <PlatformIcon platform={issue.repo.platform} /> 在 {platform} 打开 Issue
            </a>
            {issue.prUrl?.startsWith('https://') && (
              <a
                className="button button--primary"
                href={issue.prUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开 PR {prLabel(issue.prUrl)}
              </a>
            )}
          </div>
        </div>
      </section>
      <div className="issue-columns">
        <section className="card issue-timeline">
          <div className="row between">
            <h2>时间线</h2>
            <div className="timeline-filters" aria-label="时间线筛选">
              {(
                [
                  ['all', '全部'],
                  ['runs', '只看运行'],
                  ['commands', '隐藏不算指令的评论'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {feedback.isPending && <p className="muted">加载反馈中…</p>}
          {feedback.isError && <p className="error-box">加载反馈失败</p>}
          <div className="timeline-events">
            {events
              .filter((event) =>
                filter === 'runs'
                  ? event.type === 'run'
                  : filter !== 'commands' || event.type !== 'feedback' || event.item.isCommand,
              )
              .map((event) => {
                if (event.type === 'queued')
                  return (
                    <div className="timeline-event" key="queued">
                      <span className="timeline-dot" aria-hidden="true" />
                      <strong>workling 首次入队</strong> · {formatTime(issue.createdAt, now)}
                    </div>
                  )
                if (event.type === 'triage') {
                  const t = event.item
                  return (
                    <div className="timeline-event" key={`triage-${t.id}`}>
                      <span className="timeline-dot timeline-dot--warn" aria-hidden="true" />
                      <span className="badge">分诊</span> {t.decision ?? '无结论'}
                      {t.llmDecision && t.llmDecision !== t.decision && (
                        <> · LLM：{t.llmDecision}</>
                      )}{' '}
                      · {formatTime(new Date(t.triagedAt), now)}
                      {t.missing.length > 0 && <p>缺少：{t.missing.join('、')}</p>}
                      {t.suggestCommentUrl && (
                        <a href={t.suggestCommentUrl} target="_blank" rel="noopener noreferrer">
                          已评论
                        </a>
                      )}
                      {t.autoQueuedAt && <span> · 已自动打 ready</span>}
                    </div>
                  )
                }
                if (event.type === 'run') {
                  const run = event.item
                  const status = runResult(run)
                  return (
                    <div className="timeline-event" id={`run-${run.id}`} key={`run-${run.id}`}>
                      <span
                        className={`timeline-dot timeline-dot--run timeline-dot--${status === 'running' && run.kind === 'rework' ? 'rework' : status}`}
                        aria-hidden="true"
                      >
                        {status === 'done' ? '✓' : status === 'failed' ? '×' : '●'}
                      </span>
                      <RunCard
                        run={run}
                        attempt={rounds.get(run.id)!}
                        now={now}
                        defaultOpen={run.id === runs[0]?.id}
                        onFinished={onFinished}
                      />
                    </div>
                  )
                }
                const item = event.item
                const round = item.runId === null ? undefined : rounds.get(item.runId)
                return (
                  <div
                    className={`timeline-event${item.isCommand ? '' : ' timeline-event--muted'}`}
                    key={`feedback-${item.id}`}
                  >
                    <span
                      className={`timeline-dot${item.isCommand ? ' timeline-dot--rework' : ''}`}
                      aria-hidden="true"
                    />
                    <div>
                      {item.authorLogin} · {feedbackSources[item.source] ?? item.source}
                      {item.source === 'review' && item.reviewState
                        ? `（${item.reviewState}）`
                        : ''}{' '}
                      · {feedbackTrust[item.trust] ?? item.trust} ·{' '}
                      {item.isCommand ? '算作指令' : '不算指令'} ·{' '}
                      {formatTime(new Date(item.createdAt), now)}
                    </div>
                    <blockquote>
                      {item.path && (
                        <div className="mono">
                          {item.path}
                          {item.line !== null && `:${item.line}`}
                        </div>
                      )}
                      {(item.instruction ?? item.body).slice(0, 300)}
                    </blockquote>
                    <div>
                      {(item.status === 'included' || item.status === 'replied') &&
                      round !== undefined ? (
                        <a href={`#run-${item.runId}`}>→ 由第 {round} 轮处理</a>
                      ) : item.status === 'pending' ? (
                        '→ 已入队'
                      ) : item.status === 'observed' ? (
                        '→ 待处理'
                      ) : item.status === 'capped' ? (
                        '→ 超过自动返工上限，未处理'
                      ) : null}{' '}
                      ·{' '}
                      <a href={item.url} target="_blank" rel="noopener noreferrer">
                        查看原评论
                      </a>
                    </div>
                  </div>
                )
              })}
          </div>
        </section>
        <aside className="issue-sidebar">
          <section className="card">
            <h2>接着推进</h2>
            {['running', 'rework', 'queued'].includes(issue.stage) ? (
              <p>正在处理中，新的指令会在本轮结束后接着处理。</p>
            ) : (
              <>
                <p>在 Issue 或 PR 里评论，workling 会在同一分支上接着做：</p>
                <pre>/workling 补充：…{'\n'}@workling-agent 再看下…</pre>
                <p className="muted">
                  只有写权限或受信账号的评论算指令。PR 上的 Request changes 会自动触发返工。
                </p>
              </>
            )}
          </section>
          {issue.prUrl && (
            <section className="card">
              <div className="row between">
                <h2>自动返工</h2>
                {rework.limit !== null && (
                  <span>
                    {rework.rounds} / {rework.limit} 轮
                  </span>
                )}
              </div>
              {rework.limit === null ? (
                <p>已自动返工 {rework.rounds} 轮</p>
              ) : (
                <>
                  <div className="rework-boxes" aria-hidden="true">
                    {Array.from({ length: rework.limit }, (_, index) => (
                      <span key={index} className={index < rework.rounds ? 'filled' : ''} />
                    ))}
                  </div>
                  <p>
                    {rework.rounds >= rework.limit
                      ? '已用完。之后的 Request changes 只记录，需要评论 /workling 才会继续。'
                      : `还可自动返工 ${rework.limit - rework.rounds} 轮`}
                  </p>
                </>
              )}
            </section>
          )}
          <section className="card">
            <h2>反馈</h2>
            {feedback.isError ? (
              <p>加载失败</p>
            ) : feedback.isPending ? (
              <p>加载中…</p>
            ) : items.length === 0 ? (
              <p className="muted">暂无反馈</p>
            ) : (
              <>
                <p>
                  指令：{commands.length} 条 · 已处理{' '}
                  {commands.filter((x) => ['included', 'replied'].includes(x.status)).length} ·
                  处理中 {commands.filter((x) => ['observed', 'pending'].includes(x.status)).length}
                  {commands.some((x) => x.status === 'capped') &&
                    ` · 超上限 ${commands.filter((x) => x.status === 'capped').length}`}
                </p>
                <p>不算指令：{items.length - commands.length} 条</p>
                {latest && (
                  <p>
                    最近：{latest.authorLogin} · {relativeTime(new Date(latest.createdAt), now)}
                  </p>
                )}
              </>
            )}
          </section>
          <section className="card">
            <h2>交付</h2>
            <p>
              分支：<code className="path">{issue.branch ?? '—'}</code>
            </p>
            <p>
              PR：
              <PR url={issue.prUrl} state={issue.prState} />
            </p>
            <p>
              任务目录：<code className="path">{runs[0]?.taskDir ?? '—'}</code>
            </p>
          </section>
        </aside>
      </div>
    </>
  )
}
