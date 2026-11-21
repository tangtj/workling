import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { runResult } from '../../overview-view.ts'
import { platformName } from '../../platform.ts'
import { formatDuration, formatTime } from '../../format.ts'
import { issueDetailOptions, parseDetailId } from '../issue-detail.ts'
import { Badge, PlatformIcon, PR } from '../issue-table.tsx'
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
    <div className="card">
      <div className="row between">
        <div className="row">
          <strong>第 {attempt} 次</strong>
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

function FeedbackList({ id, now }: { id: number; now: number }) {
  const list = useQuery({
    queryKey: ['feedback', id],
    queryFn: ({ signal }) => loadFeedback(id, signal),
  })
  return (
    <section className="card">
      <h2>反馈</h2>
      {list.isPending && <p>加载中…</p>}
      {list.isError && <p className="error-box">加载反馈失败</p>}
      {list.data?.length === 0 && <p className="muted">暂无反馈</p>}
      {list.data?.map((item) => (
        <div className="item" key={item.id}>
          <p>
            {feedbackSources[item.source]}
            {item.source === 'review' && item.reviewState ? `（${item.reviewState}）` : ''} ·{' '}
            {item.authorLogin} · {feedbackTrust[item.trust]} ·{' '}
            {item.status === 'observed' ? (
              '指令（待处理）'
            ) : item.status === 'pending' ? (
              '已入队'
            ) : item.status === 'included' && item.runId ? (
              <a href={`/runs/${item.runId}/log`}>已处理</a>
            ) : item.status === 'replied' ? (
              '已回复'
            ) : (
              '不算指令'
            )}{' '}
            · {formatTime(new Date(item.createdAt), now)}
          </p>
          <p>{item.instruction ?? item.body.slice(0, 200)}</p>
          {item.path && (
            <p>
              {item.path}
              {item.line !== null && `:${item.line}`}
            </p>
          )}
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            查看原评论
          </a>
        </div>
      ))}
    </section>
  )
}

export function IssuePage() {
  const issueId = parseDetailId(useParams().id)
  const options = issueDetailOptions(issueId)
  const page = useQuery(options)
  const queryClient = useQueryClient()
  const { setActive } = usePageLayout()
  const data = page.data

  useEffect(() => {
    if (data) {
      document.title = 'Issue 详情 · Workling'
      setActive('issues')
    }
  }, [Boolean(data), setActive])

  const onFinished = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: issueDetailOptions(issueId).queryKey })
    void queryClient.invalidateQueries({ queryKey: shellKey })
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

  const { issue, runs, now } = data
  const platform = platformName[issue.repo.platform]
  return (
    <>
      {error}
      <nav className="breadcrumbs">
        <Link to="/repos">仓库</Link> / <Link to={`/repos/${issue.repoId}`}>{issue.repo.ref}</Link>{' '}
        / #{issue.number}
      </nav>
      <section className="card">
        <div className="row between">
          <div>
            <div className="row">
              <h1 className="mono">#{issue.number}</h1>
              <Badge status={issue.status} />
            </div>
            <h2>{issue.title ?? <span className="muted">（未记录标题）</span>}</h2>
            <p className="muted">
              共执行 {runs.length} 次　首次入队 {formatTime(issue.createdAt, now)}
              　状态更新 {formatTime(issue.updatedAt, now)}
            </p>
          </div>
          <div className="row">
            <a
              className="button button--primary"
              href={`https://${issue.repo.host}/${issue.repo.path}/issues/${issue.number}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`在 ${platform} 打开`}
            >
              <PlatformIcon platform={issue.repo.platform} /> 在 {platform} 打开
            </a>
            <PR url={issue.prUrl} state={issue.prState} variant="detail" />
          </div>
        </div>
      </section>
      {['failed', 'done', 'canceled'].includes(issue.status) && (
        <div className="notice">
          重试：在 GitHub 上给这个 Issue 重新打上 <code>workling:ready</code>
          ，下一轮轮询会重新入队。
        </div>
      )}
      <FeedbackList id={issue.id} now={now} />
      <section className="stack">
        <h2>执行历史</h2>
        {runs.length ? (
          runs.map((run, index) => (
            <RunCard
              key={run.id}
              run={run}
              attempt={runs.length - index}
              now={now}
              defaultOpen={index === 0}
              onFinished={onFinished}
            />
          ))
        ) : (
          <div className="card empty">尚未执行</div>
        )}
      </section>
    </>
  )
}
