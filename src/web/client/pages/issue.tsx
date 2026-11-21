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
    <button className="button button--sm" type="button" onClick={() => void copy()}>
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
  // 执行过程单独折叠：只有展开时才拉取事件流，最新一轮默认展开以便实时刷新。
  const [processOpen, setProcessOpen] = useState(defaultOpen)
  const status = runResult(run)
  const kind = run.kind === 'rework' ? '返工' : '实现'
  return (
    <div className="run-card">
      <button
        type="button"
        className="tl-head tl-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <strong>
          第 {attempt} 轮 · {kind}
        </strong>
        <Badge status={status} text={run.error === '进程中断' ? '中断' : undefined} />
        <span className="tl-time">
          {formatTime(run.startedAt, now)} –{' '}
          {run.endedAt
            ? formatTime(run.endedAt, now)
            : `已运行 ${formatDuration(now - run.startedAt.getTime())}`}
        </span>
        <span className="tl-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="run-box">
          <dl className="run-stats">
            <div>
              <dt>用时</dt>
              <dd>{formatDuration((run.endedAt?.getTime() ?? now) - run.startedAt.getTime())}</dd>
            </div>
            <div>
              <dt>退出码</dt>
              <dd>{run.exitCode ?? '—'}</dd>
            </div>
            <div>
              <dt>codex 结论</dt>
              <dd>{run.reportResult ?? '—'}</dd>
            </div>
            <div>
              <dt>机器</dt>
              <dd className="mono">{run.worker}</dd>
            </div>
          </dl>
          {run.error && <p className="run-error">{run.error}</p>}
          {run.summary && <p className="run-summary">Pi 结论：{run.summary}</p>}
          <details
            className="run-process"
            open={processOpen}
            onToggle={(event) => setProcessOpen(event.currentTarget.open)}
          >
            <summary>执行过程</summary>
            <RunTimeline
              variant="compact"
              runId={run.id}
              ended={run.endedAt !== null}
              status={status}
              enabled={processOpen}
              logTail={run.logTail}
              onFinished={onFinished}
            />
          </details>
          <div className="run-foot">
            <Link to={`/runs/${run.id}/log`}>{run.endedAt ? '完整日志' : '实时日志'}</Link>
            {run.taskDir && (
              <>
                <code className="path" title="任务目录">
                  {run.taskDir}
                </code>
                <CopyPath path={run.taskDir} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const feedbackSources: Record<string, string> = {
  issue_comment: 'Issue 评论',
  pr_comment: 'PR 评论',
  review_comment: '行内评论',
  review: 'Review',
}
const reviewStates: Record<string, string> = {
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  COMMENTED: 'Commented',
  DISMISSED: 'Dismissed',
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
  const shortBase =
    issue.baseRef && /^[a-f0-9]{40}$/i.test(issue.baseRef)
      ? issue.baseRef.slice(0, 7)
      : issue.baseRef
  const handled = commands.filter((x) => ['included', 'replied'].includes(x.status)).length
  const inProgress = commands.filter((x) => ['observed', 'pending'].includes(x.status)).length
  const capped = commands.filter((x) => x.status === 'capped').length
  return (
    <>
      {error}
      <nav className="breadcrumbs">
        <Link to="/issues">任务</Link> /{' '}
        <Link to={`/repos/${issue.repoId}`}>{issue.repo.path}</Link> / #{issue.number}
      </nav>
      <section className="card issue-header">
        <div className="issue-header-main">
          <div className="issue-header-tags">
            <span className="mono muted">#{issue.number}</span>
            <StageBadge
              stage={issue.stage}
              text={
                issue.stage === 'running' || issue.stage === 'rework'
                  ? `${issue.stage === 'running' ? '执行中' : '返工中'} · 第 ${runs.length} 轮`
                  : undefined
              }
            />
            {issue.prUrl && (
              <span className="badge badge--review">
                PR {prLabel(issue.prUrl)} · {prState}
              </span>
            )}
          </div>
          <h1>{issue.title ?? <span className="muted">（未记录标题）</span>}</h1>
          <p className="issue-meta">
            {issue.branch && (
              <>
                分支 <code>{issue.branch}</code> ·{' '}
              </>
            )}
            {shortBase && (
              <>
                基于 <code title={issue.baseRef ?? undefined}>{shortBase}</code> ·{' '}
              </>
            )}
            首次入队 {formatTime(issue.createdAt, now)} · 共 {runs.length} 轮
            {runs.length > 0 && <> · 累计 {formatDuration(duration)}</>}
          </p>
        </div>
        <div className="issue-header-actions">
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
      </section>
      <div className="issue-columns">
        <section className="card issue-timeline">
          <header className="card-head card-head--wrap">
            <h2>时间线</h2>
            <div className="chips" role="group" aria-label="时间线筛选">
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
                  className="chip"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </header>
          {feedback.isError && <p className="error-box">加载反馈失败</p>}
          <ol className="timeline">
            {events
              .filter((event) =>
                filter === 'runs'
                  ? event.type === 'run'
                  : filter !== 'commands' || event.type !== 'feedback' || event.item.isCommand,
              )
              .map((event) => {
                if (event.type === 'queued')
                  return (
                    <li className="tl-event" key="queued">
                      <span className="tl-node" aria-hidden="true" />
                      <div className="tl-head">
                        <strong>workling 首次入队</strong>
                        <span className="tl-time">{formatTime(issue.createdAt, now)}</span>
                      </div>
                    </li>
                  )
                if (event.type === 'triage') {
                  const t = event.item
                  return (
                    <li className="tl-event" key={`triage-${t.id}`}>
                      <span className="tl-node tl-node--warn" aria-hidden="true" />
                      <div className="tl-head">
                        <span className="badge badge--info">分诊</span>
                        <span>
                          结论 {t.decision ?? '无结论'}
                          {t.llmDecision && t.llmDecision !== t.decision && (
                            <span className="muted">（LLM：{t.llmDecision}）</span>
                          )}
                          {t.missing.length > 0 && <>；缺少 {t.missing.join('、')}</>}
                        </span>
                        <span className="tl-time">{formatTime(new Date(t.triagedAt), now)}</span>
                      </div>
                      {(t.suggestCommentUrl || t.autoQueuedAt) && (
                        <p className="tl-note">
                          {t.suggestCommentUrl && (
                            <a href={t.suggestCommentUrl} target="_blank" rel="noopener noreferrer">
                              已评论
                            </a>
                          )}
                          {t.suggestCommentUrl && t.autoQueuedAt && ' · '}
                          {t.autoQueuedAt && '已自动打 ready'}
                        </p>
                      )}
                    </li>
                  )
                }
                if (event.type === 'run') {
                  const run = event.item
                  const status = runResult(run)
                  return (
                    <li
                      className="tl-event tl-event--run"
                      id={`run-${run.id}`}
                      key={`run-${run.id}`}
                    >
                      <span
                        className={`tl-node tl-node--run tl-node--${status === 'running' && run.kind === 'rework' ? 'rework' : status}`}
                        aria-hidden="true"
                      />
                      <RunCard
                        run={run}
                        attempt={rounds.get(run.id)!}
                        now={now}
                        defaultOpen={run.id === runs[0]?.id}
                        onFinished={onFinished}
                      />
                    </li>
                  )
                }
                const item = event.item
                const round = item.runId === null ? undefined : rounds.get(item.runId)
                const source =
                  item.source === 'review' && item.reviewState
                    ? `Review · ${reviewStates[item.reviewState] ?? item.reviewState}`
                    : (feedbackSources[item.source] ?? item.source)
                return (
                  <li
                    className={`tl-event${item.isCommand ? '' : ' tl-event--muted'}`}
                    key={`feedback-${item.id}`}
                  >
                    <span
                      className={`tl-node${item.isCommand ? ' tl-node--rework' : ''}`}
                      aria-hidden="true"
                    />
                    <div className="tl-head">
                      <strong>{item.authorLogin}</strong>
                      <span className={`badge${item.isCommand ? ' badge--rework' : ''}`}>
                        {source}
                      </span>
                      <span className="tl-time">
                        {feedbackTrust[item.trust] ?? item.trust} ·{' '}
                        {item.isCommand ? '算作指令' : '不算指令'} ·{' '}
                        {formatTime(new Date(item.createdAt), now)}
                      </span>
                    </div>
                    <blockquote className="tl-quote">
                      {item.path && (
                        <div className="tl-quote-path mono">
                          {item.path}
                          {item.line !== null && `:${item.line}`}
                        </div>
                      )}
                      {(item.instruction ?? item.body).slice(0, 300)}
                    </blockquote>
                    <p className="tl-note">
                      {(item.status === 'included' || item.status === 'replied') &&
                      round !== undefined ? (
                        <a href={`#run-${item.runId}`}>→ 由第 {round} 轮处理</a>
                      ) : item.status === 'pending' ? (
                        '→ 已入队'
                      ) : item.status === 'observed' ? (
                        '→ 待处理'
                      ) : item.status === 'capped' ? (
                        '→ 超过自动返工上限，未处理'
                      ) : null}
                      {item.status !== 'ignored' && ' · '}
                      <a href={item.url} target="_blank" rel="noopener noreferrer">
                        查看原评论
                      </a>
                    </p>
                  </li>
                )
              })}
          </ol>
          {feedback.isPending && <p className="tl-loading muted">加载反馈中…</p>}
        </section>
        <aside className="issue-sidebar">
          <section className="card">
            <header className="card-head">
              <h2>接着推进</h2>
            </header>
            <div className="card-body">
              {['running', 'rework', 'queued'].includes(issue.stage) ? (
                <p>正在处理中，新的指令会在本轮结束后接着处理。</p>
              ) : (
                <>
                  <p>在 Issue 或 PR 里评论，workling 会在同一分支上接着做：</p>
                  <pre className="hint-code">/workling 补充：…{'\n'}@workling-agent 再看下…</pre>
                  <p className="card-note">
                    只有写权限或受信账号的评论算指令。PR 上的 Request changes 会自动触发返工。
                  </p>
                </>
              )}
            </div>
          </section>
          {issue.prUrl && (
            <section className="card">
              <header className="card-head">
                <h2>自动返工</h2>
                {rework.limit !== null && (
                  <span className="muted">
                    {rework.rounds} / {rework.limit} 轮
                  </span>
                )}
              </header>
              <div className="card-body">
                {rework.limit === null ? (
                  <p>已自动返工 {rework.rounds} 轮</p>
                ) : (
                  <>
                    {rework.limit > 0 && (
                      <div className="rework-bars" aria-hidden="true">
                        {Array.from({ length: rework.limit }, (_, index) => (
                          <span key={index} className={index < rework.rounds ? 'filled' : ''} />
                        ))}
                      </div>
                    )}
                    <p className="card-note">
                      {rework.rounds >= rework.limit
                        ? '已用完。之后的 Request changes 只记录，需要评论 /workling 才会继续。'
                        : `还可自动返工 ${rework.limit - rework.rounds} 轮`}
                    </p>
                  </>
                )}
              </div>
            </section>
          )}
          <section className="card">
            <header className="card-head">
              <h2>反馈</h2>
            </header>
            <div className="card-body">
              {feedback.isError ? (
                <p>加载失败</p>
              ) : feedback.isPending ? (
                <p className="muted">加载中…</p>
              ) : items.length === 0 ? (
                <p className="muted">暂无反馈</p>
              ) : (
                <dl className="kv-list">
                  <dt>指令</dt>
                  <dd>
                    {commands.length} 条 · 已处理 {handled} · 处理中 {inProgress}
                    {capped > 0 && ` · 超上限 ${capped}`}
                  </dd>
                  <dt>不算指令</dt>
                  <dd>{items.length - commands.length} 条</dd>
                  {latest && (
                    <>
                      <dt>最近</dt>
                      <dd>
                        {latest.authorLogin} · {relativeTime(new Date(latest.createdAt), now)}
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          </section>
          <section className="card">
            <header className="card-head">
              <h2>交付</h2>
            </header>
            <div className="card-body">
              <dl className="kv-list">
                <dt>分支</dt>
                <dd className="mono">{issue.branch ?? '—'}</dd>
                <dt>PR</dt>
                <dd>
                  <PR url={issue.prUrl} state={issue.prState} />
                </dd>
                <dt>任务目录</dt>
                <dd className="mono path">{runs[0]?.taskDir ?? '—'}</dd>
              </dl>
            </div>
          </section>
        </aside>
      </div>
    </>
  )
}
