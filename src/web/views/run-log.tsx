import { assetUrl } from '../assets.ts'
import type { Issue, PageData, Run } from '../data.ts'
import { formatDuration, formatTime } from './format.ts'

import { Badge, Title, result, resultText, IssueLink } from './shared.tsx'

export function RunLogPage({ data, issue, run }: { data: PageData; issue: Issue; run: Run }) {
  return (
    <>
      <header class="page-header">
        <div>
          <h1>执行日志</h1>
          <p>
            <IssueLink issue={issue} /> · <Title issue={issue} />
          </p>
          <div class="row">
            <strong>第 {issue.runs.length - issue.runs.indexOf(run)} 次</strong>
            <Badge status={result(run)} text={resultText(run)} />
          </div>
          <p>
            开始 {formatTime(run.startedAt, data.now)} · 用时{' '}
            {formatDuration((run.endedAt?.getTime() ?? data.now) - run.startedAt.getTime())} ·{' '}
            {run.worker} · {run.container ? `容器：${run.container}` : `pid：${run.pid ?? '—'}`}
          </p>
        </div>
      </header>
      {(run.summary || run.reportResult) && (
        <section class="card">
          {run.reportResult && <p>codex：{run.reportResult}</p>}
          {run.summary && (
            <>
              <h2>Pi 结论</h2>
              <pre>{run.summary}</pre>
            </>
          )}
        </section>
      )}
      <ol class="run-phases" aria-label="执行阶段">
        {['准备', '读取 Issue', 'codex 实现', '核对', '交付 PR'].map((phase, n) => (
          <li data-phase={n} class={n === 0 ? 'badge badge--running' : 'badge'}>
            {phase}
          </li>
        ))}
      </ol>
      <section class="card">
        <div class="row log-toolbar">
          <div class="row" role="group" aria-label="筛选步骤">
            {(
              [
                ['all', '全部'],
                ['command', '命令'],
                ['file', '文件'],
                ['message', '说明'],
                ['error', '错误'],
              ] as const
            ).map(([key, label]) => (
              <button type="button" class="button" data-filter={key} aria-pressed={key === 'all'}>
                {label}{' '}
                <span class="muted filter-count" data-count={key}>
                  0
                </span>
              </button>
            ))}
          </div>
          <label class="checkbox">
            <input id="log-follow" type="checkbox" checked />
            跟随最新
          </label>
          <button id="log-raw-toggle" class="button" type="button" aria-pressed="false">
            原始日志
          </button>
          <a href={`/api/runs/${run.id}/log`} download>
            下载
          </a>
          <span id="log-live" hidden={!!run.endedAt}>
            实时更新中
          </span>
        </div>
        <p id="log-error" class="error-box" role="alert" hidden></p>
        <div
          id="run-timeline"
          class="run-timeline"
          data-run-id={run.id}
          data-ended={String(!!run.endedAt)}
          data-status={result(run)}
        ></div>
        <pre id="run-log" hidden></pre>
      </section>
      <script type="module" src={assetUrl('run-log.js')}></script>
    </>
  )
}
