import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { runResult } from '../../overview-view.ts'
import { platformName } from '../../platform.ts'
import { formatDuration, formatTime } from '../../views/format.ts'
import { issueDetailOptions, parseDetailId } from '../issue-detail.ts'
import { Badge, PlatformIcon, PR } from '../issue-table.tsx'
import { shellKey, usePageLayout } from '../layout.tsx'
import { NotFound } from '../legacy-page.tsx'
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
          {formatTime(run.startedAt, now)}
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
