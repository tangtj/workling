import { Link } from 'react-router'
import * as Value from 'typebox/value'
import { issueReviewsSchema, type IssueReview } from '../review.ts'
import { formatTime } from '../format.ts'
import { readResponse } from './http.ts'

export function issueReviewsOptions(issueId: number | undefined) {
  return {
    queryKey: ['issue-reviews', issueId],
    enabled: issueId !== undefined,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const response = await readResponse(`/api/issues/${issueId}/reviews`, { signal })
      if (!response.ok) throw new Error('加载评审失败')
      const body: unknown = await response.json()
      if (!Value.Check(issueReviewsSchema, body)) throw new Error('评审数据无效')
      return body
    },
    refetchInterval: 5000,
  }
}

const statusLabels = {
  queued: '排队中',
  running: '评审中',
  failed: '失败',
  skipped: '已跳过',
}
const severityLabels = { blocker: '阻断', major: '主要', minor: '次要' }

export function ReviewCard({ review, now }: { review: IssueReview; now: number }) {
  const status =
    review.status === 'done'
      ? review.verdict === 'pass'
        ? '通过'
        : '需修改'
      : statusLabels[review.status]
  const met = review.acceptance.filter((entry) => entry.met === 'yes').length
  const unresolved = review.acceptance.filter((entry) => entry.met !== 'yes')
  return (
    <div className="run-card" id={review.runId === null ? undefined : `run-${review.runId}`}>
      <div className="tl-head">
        <strong>评审</strong>
        <span className="badge badge--review">{status}</span>
        <span className="tl-time">
          {formatTime(new Date(review.endedAt ?? review.createdAt), now)}
        </span>
      </div>
      <div className="run-box">
        {review.error && <p className="run-error">{review.error}</p>}
        {review.summary && <p className="run-summary">{review.summary}</p>}
        {review.checks.length > 0 && (
          <section>
            <h3>检查</h3>
            <ul>
              {review.checks.map((entry, index) => (
                <li key={index}>
                  <code>{entry.command}</code> · {entry.passed ? '通过' : '失败'}
                  {entry.detail && <p>{entry.detail}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {review.acceptance.length > 0 && (
          <section>
            <h3>验收 · {met} 项已满足</h3>
            {unresolved.length > 0 && (
              <ul>
                {unresolved.map((entry, index) => (
                  <li key={index}>
                    {entry.met === 'no' ? '未满足' : '无法确认'} · {entry.item}
                    {entry.evidence && <p>{entry.evidence}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {(Object.keys(severityLabels) as Array<keyof typeof severityLabels>).map((severity) => {
          const findings = review.findings.filter((finding) => finding.severity === severity)
          if (!findings.length) return null
          return (
            <section key={severity}>
              <h3>{severityLabels[severity]}发现</h3>
              <ul>
                {findings.map((item, index) => (
                  <li key={index}>
                    {item.path && (
                      <code>
                        {item.path}
                        {item.line !== null && `:${item.line}`}
                      </code>
                    )}
                    {item.known && <span className="badge">实现方已声明</span>}
                    <p>触发场景：{item.scenario}</p>
                    <p>{item.body}</p>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
        {review.runId !== null && (
          <div className="run-foot">
            <Link to={`/runs/${review.runId}/log`}>{review.endedAt ? '完整日志' : '实时日志'}</Link>
          </div>
        )}
      </div>
    </div>
  )
}
