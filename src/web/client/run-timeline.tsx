import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { counts, phaseOf, type TimelineItem, type TimelineState } from '../timeline.ts'
import { useRawLog, useRunEvents } from './run-events.ts'

const filters = [
  ['all', '全部'],
  ['command', '命令'],
  ['file', '文件'],
  ['message', '说明'],
  ['error', '错误'],
] as const
type Filter = (typeof filters)[number][0]
type RunStatus = 'running' | 'done' | 'failed' | 'canceled'

export function useSecondClock(active: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function formatSeconds(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function CodexElapsed({ startedAt, ticking }: { startedAt: string; ticking: boolean }) {
  const now = useSecondClock(ticking)
  return formatSeconds(now - new Date(startedAt).getTime())
}

function itemStatus(item: TimelineItem) {
  if ('status' in item) return item.status
  if (item.kind !== 'exit') return ''
  return hasFailedExit(item) ? 'error' : item.code === 0 ? 'ok' : ''
}

function hasFailedExit(item: TimelineItem) {
  return (
    item.kind === 'exit' && (Boolean(item.signal) || (item.code !== undefined && item.code !== 0))
  )
}

function visible(item: TimelineItem, filter: Filter) {
  return (
    filter === 'all' ||
    (filter === 'command' && item.kind === 'codex') ||
    item.kind === filter ||
    (filter === 'error' &&
      (('status' in item && item.status === 'error') || item.kind === 'warning'))
  )
}

function heading(item: Exclude<TimelineItem, { kind: 'output' }>) {
  switch (item.kind) {
    case 'codex':
      return 'codex exec'
    case 'command': {
      const lines = item.command.split('\n')
      return `${lines[0]}${lines.length > 1 ? `（共 ${lines.length} 行）` : ''}`
    }
    case 'file':
      return `${item.action} ${item.path}`
    case 'tool':
      return `调用 ${item.name}`
    case 'exit':
      return item.text ?? `Pi 结束 · ${item.signal ? `信号 ${item.signal}` : `退出码 ${item.code}`}`
    default:
      return item.text
  }
}

const Entry = memo(function Entry({
  item,
  hidden,
  ended,
  ticking,
  failedOutput,
}: {
  item: TimelineItem
  hidden: boolean
  ended: boolean
  ticking: boolean
  failedOutput: boolean
}) {
  const className = `timeline-entry timeline-entry--${item.kind}`
  if (item.kind === 'output')
    return (
      <article className={className} hidden={hidden} data-status={failedOutput ? 'error' : ''}>
        <pre className="mono">{item.lines.slice(0, 6).join('\n')}</pre>
        <details className="timeline-details" hidden={item.lines.length <= 6}>
          <summary className="">展开全部（共 {item.lines.length} 行）</summary>
          <pre className="mono">{item.lines.slice(6).join('\n')}</pre>
        </details>
      </article>
    )
  const icons = {
    step: '⎇',
    command: '$',
    file: item.kind === 'file' && item.action === '读取' ? '⌕' : '✎',
    message: '”',
    codex: '◆',
    warning: '!',
    exit: '■',
    tool: '⎇',
  }
  const status = itemStatus(item)
  const time =
    item.kind !== 'codex' && item.ts
      ? /^\d\d:\d\d:\d\d$/.test(item.ts)
        ? item.ts
        : new Date(item.ts).toLocaleTimeString()
      : ''
  const duration = 'durationMs' in item ? item.durationMs : undefined
  const row = (
    <>
      <span className={`timeline-heading${item.kind === 'command' ? ' mono' : ''}`}>
        {heading(item)}
      </span>
      {item.kind === 'codex' && (
        <span className="timeline-model mono">
          {item.model || '默认'} · {item.effort || '默认'}
        </span>
      )}
      <span className="timeline-meta">
        <span className="timeline-status" data-status={status}>
          {status === 'ok' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '运行中' : ''}
        </span>
        <span className="timeline-meta-time">
          {item.kind === 'codex' && item.status === 'running' && !ended && item.startedAt ? (
            <CodexElapsed startedAt={item.startedAt} ticking={ticking} />
          ) : (
            [time, duration === undefined ? '' : formatSeconds(duration)]
              .filter(Boolean)
              .join(' · ')
          )}
        </span>
      </span>
    </>
  )
  return (
    <article className={className} data-status={status} hidden={hidden}>
      <span className="timeline-icon" aria-hidden="true">
        {'status' in item && item.status === 'error' ? '!' : icons[item.kind]}
      </span>
      <div className={`timeline-body${item.kind === 'codex' ? ' timeline-codex-card' : ''}`}>
        {item.kind === 'command' ? (
          <details className="timeline-command">
            <summary className="timeline-row">{row}</summary>
            <pre className="mono">{item.command}</pre>
            <pre className="mono">{item.output}</pre>
          </details>
        ) : (
          <div className="timeline-row">{row}</div>
        )}
        {item.kind === 'codex' && (
          <>
            <p className="timeline-latest mono">最新：{item.latest || '等待输出'}</p>
            <details className="timeline-details">
              <summary className="">展开 codex 输出</summary>
              <pre className="mono">{item.command}</pre>
              <pre className="mono">{item.output}</pre>
            </details>
          </>
        )}
      </div>
    </article>
  )
})

function RunPhases({
  state,
  ended,
  status,
}: {
  state: TimelineState
  ended: boolean
  status: RunStatus
}) {
  const phase = phaseOf(state)
  const failed =
    ended && (status === 'failed' || status === 'canceled' || state.items.some(hasFailedExit))
  return (
    <ol className="run-phases" aria-label="执行阶段">
      {['准备', '读取 Issue', 'codex 实现', '核对', '交付 PR'].map((label, index) => {
        const current = index === phase
        const complete = index < phase || (current && ended && !failed)
        const badge = complete ? 'done' : current ? (failed ? 'failed' : 'running') : ''
        return (
          <li
            key={label}
            data-phase={index}
            className={`badge${badge ? ` badge--${badge}` : ''}`}
            aria-current={current ? 'step' : undefined}
          >
            {complete ? '✓ ' : current ? (failed ? '✗ ' : '● ') : ''}
            {label}
          </li>
        )
      })}
    </ol>
  )
}

type RunTimelineProps = {
  runId: number
  ended: boolean
  status: RunStatus
  onFinished?: () => void
} & ({ variant: 'full' } | { variant: 'compact'; enabled: boolean; logTail?: string | null })

export function RunTimeline(props: RunTimelineProps) {
  // The compact renderer will replace the Issue page script in 6b.
  return props.variant === 'full' ? <FullTimeline {...props} /> : null
}

function FullTimeline({
  runId,
  ended,
  status,
  onFinished,
}: RunTimelineProps & { variant: 'full' }) {
  const [initiallyEnded] = useState(ended)
  const events = useRunEvents({ runId, initiallyEnded, enabled: true })
  const [filter, setFilter] = useState<Filter>('all')
  const [follow, setFollow] = useState(true)
  const [raw, setRaw] = useState({ visible: false, started: false })
  const content = useRawLog(runId, raw.started)
  const timeline = useRef<HTMLDivElement>(null)
  const rawLog = useRef<HTMLPreElement>(null)
  const items = events.state.items
  const totals = counts(events.state)
  const finished = ended || events.ended

  useEffect(() => {
    if (events.finishedWhileViewing) onFinished?.()
  }, [events.finishedWhileViewing, onFinished])

  const previousItems = useRef<typeof items>([])
  const previousGeneration = useRef(events.generation)
  useLayoutEffect(() => {
    const added =
      items.length > 0 &&
      (events.generation !== previousGeneration.current ||
        items.some((item, index) => previousItems.current[index]?.kind !== item.kind))
    previousItems.current = items
    previousGeneration.current = events.generation
    if (added && follow && !raw.visible) timeline.current?.scrollIntoView({ block: 'end' })
  }, [items, events.generation, follow, raw.visible])

  useLayoutEffect(() => {
    const node = rawLog.current
    if (node && follow && raw.visible) node.scrollTop = node.scrollHeight
  }, [content, follow, raw.visible])

  return (
    <>
      <RunPhases state={events.state} ended={finished} status={status} />
      <section className="card">
        <div className="row log-toolbar">
          <div className="row" role="group" aria-label="筛选步骤">
            {filters.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="button"
                data-filter={key}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}{' '}
                <span className="muted filter-count" data-count={key}>
                  {totals[key]}
                </span>
              </button>
            ))}
          </div>
          <label className="checkbox">
            <input
              id="log-follow"
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />
            跟随最新
          </label>
          <button
            id="log-raw-toggle"
            className="button"
            type="button"
            aria-pressed={raw.visible}
            onClick={() => setRaw((value) => ({ visible: !value.visible, started: true }))}
          >
            原始日志
          </button>
          <a href={`/api/runs/${runId}/log`} download>
            下载
          </a>
          <span id="log-live" hidden={finished}>
            实时更新中
          </span>
        </div>
        <p id="log-error" className="error-box" role="alert" hidden={!events.error}>
          {events.error}
        </p>
        <div
          id="run-timeline"
          className="run-timeline"
          data-run-id={runId}
          data-ended={String(ended)}
          data-status={status}
          hidden={raw.visible}
          ref={timeline}
        >
          {events.fallback && <p className="muted">此次执行没有结构化事件，以下由文本日志整理</p>}
          {items.map((item, index) => (
            <Entry
              key={`${events.generation}:${item.id}:${item.kind}`}
              item={item}
              hidden={!visible(item, filter)}
              ended={finished}
              ticking={!events.error}
              failedOutput={
                (status === 'failed' || status === 'canceled') && items[index + 1]?.kind === 'exit'
              }
            />
          ))}
        </div>
        <pre id="run-log" hidden={!raw.visible} ref={rawLog}>
          {raw.started ? content : ''}
        </pre>
      </section>
    </>
  )
}
