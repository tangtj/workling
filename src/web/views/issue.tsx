import type { Issue, PageData } from '../data.ts'
import { githubUrl } from '../data.ts'
import { formatDuration, formatTime } from './format.ts'

import { Badge, Title, result, resultText } from './shared.tsx'

export function IssuePage({ data, issue }: { data: PageData; issue: Issue }) {
  return (
    <>
      <nav class="breadcrumbs">
        <a href="/repos">仓库</a> / <a href={`/repos/${issue.repoId}`}>{issue.repo.ref}</a> / #
        {issue.number}
      </nav>
      <section class="card">
        <div class="row between">
          <div>
            <div class="row">
              <h1 class="mono">#{issue.number}</h1>
              <Badge status={issue.status} />
            </div>
            <h2>
              <Title issue={issue} />
            </h2>
            <p class="muted">
              共执行 {issue.runs.length} 次　首次入队 {formatTime(issue.createdAt, data.now)}
              　状态更新 {formatTime(issue.updatedAt, data.now)}
            </p>
          </div>
          <a class="button button--primary" href={githubUrl(issue)} rel="noreferrer">
            在 GitHub 打开 ↗
          </a>
        </div>
      </section>
      {['failed', 'done', 'canceled'].includes(issue.status) && (
        <div class="notice">
          重试：在 GitHub 上给这个 Issue 重新打上 <code>workling:ready</code>
          ，下一轮轮询会重新入队。
        </div>
      )}
      <section class="stack">
        <h2>执行历史</h2>
        {issue.runs.length ? (
          issue.runs.map((r, n) => (
            <div class="card">
              <div class="row between">
                <div class="row">
                  <strong>第 {issue.runs.length - n} 次</strong>
                  <Badge status={result(r)} text={resultText(r)} />
                  {r.reportResult && <span>codex：{r.reportResult}</span>}
                </div>
                <span class="muted">{r.worker}</span>
              </div>
              <div class="run-details">
                <div>
                  <small>开始</small>
                  {formatTime(r.startedAt, data.now)}
                </div>
                <div>
                  <small>结束</small>
                  {r.endedAt ? formatTime(r.endedAt, data.now) : '—'}
                </div>
                <div>
                  <small>用时</small>
                  {formatDuration((r.endedAt?.getTime() ?? data.now) - r.startedAt.getTime())}
                </div>
                <div>
                  <small>退出码</small>
                  {r.exitCode ?? '—'}
                </div>
              </div>
              {r.error && <div class="error-box">{r.error}</div>}
              {r.summary && (
                <details>
                  <summary>Pi 结论</summary>
                  <pre>{r.summary}</pre>
                </details>
              )}
              <details class="run-process" open={n === 0}>
                <summary>执行过程</summary>
                <div
                  class="run-timeline compact"
                  data-run-id={r.id}
                  data-ended={String(!!r.endedAt)}
                  data-status={result(r)}
                  data-limit="8"
                  data-log-tail={r.logTail ?? ''}
                ></div>
                <a href={`/runs/${r.id}/log`}>查看完整时间线</a>
              </details>
              <div class="item row">
                <span class="muted">任务目录</span>
                <code class="path">{r.taskDir ?? '—'}</code>
                <a href={`/runs/${r.id}/log`}>完整时间线</a>
                {r.taskDir && (
                  <button class="button" type="button" data-copy={r.taskDir}>
                    复制路径
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <div class="card empty">尚未执行</div>
        )}
      </section>
      <script type="module" src="/run-log.js"></script>
    </>
  )
}
