import { useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { runResult } from '../../overview-view.ts'
import { formatDuration, formatTime } from '../../format.ts'
import { issueDetailOptions, parseDetailId, runDetailOptions } from '../issue-detail.ts'
import { Badge } from '../issue-table.tsx'
import { shellKey, usePageLayout } from '../layout.tsx'
import { NotFound } from '../not-found.tsx'
import { RunTimeline, useSecondClock } from '../run-timeline.tsx'

function RunDuration({ startedAt, endedAt }: { startedAt: Date; endedAt: Date | null }) {
  const now = useSecondClock(endedAt === null)
  return formatDuration((endedAt?.getTime() ?? now) - startedAt.getTime())
}

export function RunLogPage() {
  const runId = parseDetailId(useParams().id)
  const options = runDetailOptions(runId)
  const page = useQuery(options)
  const queryClient = useQueryClient()
  const { setActive } = usePageLayout()
  const data = page.data
  const issueId = data?.issue.id
  const runIndex = data?.runs.findIndex(({ id }) => id === runId) ?? -1
  const run = data?.runs[runIndex]

  useEffect(() => {
    if (run) {
      document.title = '执行日志 · Workling'
      setActive('issues')
    }
  }, [Boolean(run), setActive])

  const onFinished = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: runDetailOptions(runId).queryKey })
    if (issueId !== undefined)
      void queryClient.invalidateQueries({ queryKey: issueDetailOptions(issueId).queryKey })
    void queryClient.invalidateQueries({ queryKey: shellKey })
  }, [queryClient, runId, issueId])

  if (!data && page.isPending) return <p className="muted">加载中…</p>
  if (!data && page.isError)
    return (
      <p className="error-box" role="alert">
        加载页面失败{' '}
        <button className="button" type="button" onClick={() => void page.refetch()}>
          重试
        </button>
      </p>
    )
  if (!data || !run) return <NotFound />

  const { issue } = data
  const status = runResult(run)
  return (
    <>
      {page.isError && (
        <p className="error-box" role="alert">
          加载页面失败{' '}
          <button className="button" type="button" onClick={() => void page.refetch()}>
            重试
          </button>
        </p>
      )}
      <header className="page-header">
        <div>
          <h1>执行日志</h1>
          <p>
            <Link to={`/issues/${issue.id}`} className="mono">
              {issue.repo.ref} #{issue.number}
            </Link>
            {' · '}
            {issue.title ?? <span className="muted">（未记录标题）</span>}
          </p>
          <div className="row">
            <strong>第 {data.runs.length - runIndex} 次</strong>
            <Badge status={status} text={run.error === '进程中断' ? '中断' : undefined} />
          </div>
          <p>
            开始 {formatTime(run.startedAt, data.now)} · 用时{' '}
            <RunDuration startedAt={run.startedAt} endedAt={run.endedAt} /> · {run.worker} ·{' '}
            {run.container ? `容器：${run.container}` : `pid：${run.pid ?? '—'}`}
          </p>
        </div>
      </header>
      {(run.summary || run.reportResult) && (
        <section className="card">
          {run.reportResult && <p>codex：{run.reportResult}</p>}
          {run.summary && (
            <>
              <h2>Pi 结论</h2>
              <pre>{run.summary}</pre>
            </>
          )}
        </section>
      )}
      <RunTimeline
        key={run.id}
        variant="full"
        runId={run.id}
        ended={run.endedAt !== null}
        status={status}
        onFinished={onFinished}
      />
    </>
  )
}
