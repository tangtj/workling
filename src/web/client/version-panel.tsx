import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { setRefreshPaused } from './refresh-pause.ts'

const jobSchema = Type.Object({
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('waiting'),
    Type.Literal('done'),
    Type.Literal('failed'),
  ]),
  logs: Type.Array(Type.String()),
  error: Type.Optional(Type.String()),
})
const infoSchema = Type.Object({
  current: Type.String(),
  channel: Type.Optional(Type.Union([Type.Literal('stable'), Type.Literal('edge')])),
  currentUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  target: Type.Optional(
    Type.Union([
      Type.Object({ version: Type.String(), notes: Type.String(), url: Type.String() }),
      Type.Null(),
    ]),
  ),
  note: Type.Optional(Type.String()),
  mode: Type.Union([Type.Literal('docker'), Type.Literal('unsupported')]),
  repoConfigured: Type.Boolean(),
  releasesUrl: Type.Union([Type.String(), Type.Null()]),
  runningTasks: Type.Number(),
  job: Type.Union([jobSchema, Type.Null()]),
  latest: Type.Optional(
    Type.Union([Type.Object({ tag: Type.String(), body: Type.String() }), Type.Null()]),
  ),
  hasUpdate: Type.Optional(Type.Boolean()),
  releaseError: Type.Optional(Type.String()),
  lastError: Type.Union([Type.String(), Type.Null()]),
  lastSuccess: Type.Union([Type.Object({ tag: Type.String(), at: Type.String() }), Type.Null()]),
})
const resultSchema = Type.Object({ job: jobSchema })
type UpdateJob = {
  status: 'running' | 'waiting' | 'done' | 'failed'
  logs: string[]
  error?: string
}
type Info = {
  current: string
  channel?: 'stable' | 'edge'
  currentUrl?: string | null
  target?: { version: string; notes: string; url: string } | null
  note?: string
  mode?: 'docker' | 'unsupported'
  repoConfigured?: boolean
  releasesUrl?: string | null
  runningTasks?: number
  job?: UpdateJob | null
  latest?: { tag: string; body: string } | null
  hasUpdate?: boolean
  releaseError?: string
  lastError?: string | null
  lastSuccess?: { tag: string; at: string } | null
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2',
    check: 'm6 12 4 4 8-8',
    arrow: 'M12 19V5m-6 6 6-6 6 6',
    info: 'M12 8h.01M12 11v5',
    warning: 'M12 6v8m0 3h.01',
    github:
      'M9 19c-4 1-4-2-6-2m12 5v-4a3 3 0 0 0-1-2c3 0 6-2 6-5a5 5 0 0 0-1-3 5 5 0 0 0 0-4s-1 0-3 2a12 12 0 0 0-8 0C6 4 5 4 5 4a5 5 0 0 0 0 4 5 5 0 0 0-1 3c0 3 3 5 6 5a3 3 0 0 0-1 2v4',
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
export function VersionPanel({ version }: { version: string }) {
  const [info, setInfo] = useState<Info>({ current: version })
  const infoRef = useRef(info)
  const merge = (data: Partial<Info>) => {
    infoRef.current = { ...infoRef.current, ...data }
    setInfo(infoRef.current)
    return infoRef.current
  }
  const [open, setOpen] = useState(false),
    [ready, setReady] = useState(false),
    [checked, setChecked] = useState(false)
  const [checking, setChecking] = useState(false),
    [busy, setBusy] = useState(false),
    [selection, setSelection] = useState('')
  const [expanded, setExpanded] = useState(false),
    [truncated, setTruncated] = useState(false),
    [mode, setMode] = useState('drain')
  const [progress, setProgress] = useState(false),
    [status, setStatus] = useState(''),
    [logs, setLogs] = useState(''),
    [waiting, setWaiting] = useState(false),
    [back, setBack] = useState(false),
    [error, setError] = useState('')
  const confirmButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (selection) confirmButton.current?.focus()
  }, [selection])
  const pill = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null),
    notes = useRef<HTMLParagraphElement>(null)
  const openRef = useRef(false)
  openRef.current = open
  const controller = useRef<AbortController>(null),
    watching = useRef(false),
    checkRunning = useRef(false),
    recheck = useRef(false),
    busyRef = useRef(false),
    checkedRef = useRef(false)
  const timers = useRef(new Map<ReturnType<typeof setTimeout>, () => void>())
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.current.delete(timer)
        resolve()
      }, ms)
      timers.current.set(timer, resolve)
    })
  const api = async <T,>(path: string, body?: object): Promise<T> => {
    const response = await fetch(`/api/system/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      signal: AbortSignal.any([
        controller.current!.signal,
        AbortSignal.timeout(path === 'version?local=1' || path === 'job' ? 5000 : 35000),
      ]),
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (response.status === 401) {
      location.assign('/login')
      throw new Error('未登录')
    }
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '操作失败')
    const schema = path.startsWith('version')
      ? infoSchema
      : path === 'job'
        ? Type.Union([jobSchema, Type.Null()])
        : resultSchema
    if (!Value.Check(schema, data)) throw new Error('版本信息无效')
    return data as T
  }
  const local = async () => merge(await api<Info>('version?local=1'))
  const check = async (force = false) => {
    if (controller.current?.signal.aborted) return
    if (checkRunning.current || busyRef.current) {
      if (force) recheck.current = true
      return
    }
    checkRunning.current = true
    setChecking(true)
    try {
      merge({
        releaseError: undefined,
        note: undefined,
        ...(await api<Info>(`version${force ? '?force=1' : ''}`)),
      })
      checkedRef.current = true
      setChecked(true)
    } catch (e) {
      if (!controller.current?.signal.aborted) merge({ releaseError: message(e) })
    } finally {
      checkRunning.current = false
      setChecking(false)
      if (recheck.current && !busyRef.current) {
        recheck.current = false
        void check(true)
      }
    }
  }
  const watch = async (job: UpdateJob | null) => {
    if (watching.current) return
    watching.current = true
    busyRef.current = true
    setBusy(true)
    setRefreshPaused(true)
    const original = infoRef.current.current
    setSelection('')
    setProgress(true)
    setBack(false)
    setError('')
    setOpen(true)
    try {
      let active = job
      while (!controller.current?.signal.aborted && active) {
        setLogs(active.logs.slice(-5).join('\n'))
        setWaiting(active.status === 'waiting')
        setStatus(active.status === 'waiting' ? '等待任务结束…' : '正在执行…')
        if (active.status === 'failed') throw new Error(active.error || '更新失败')
        if (active.status === 'done') break
        await pause(1500)
        if (controller.current?.signal.aborted) return
        try {
          active = await api<UpdateJob | null>('job')
        } catch {
          break
        }
      }
      setWaiting(false)
      setStatus('正在重启…')
      const deadline = Date.now() + 90000
      while (!controller.current?.signal.aborted && Date.now() < deadline) {
        await pause(2000)
        if (controller.current?.signal.aborted) return
        try {
          const current = await local()
          if (current.current !== original) {
            setStatus(`已更新到 ${current.current}`)
            await pause(1000)
            if (!controller.current?.signal.aborted) location.reload()
            return
          }
          if (current.lastError && !current.job)
            throw Object.assign(new Error(current.lastError), { terminal: true })
        } catch (e) {
          if (e instanceof Error && 'terminal' in e) throw e
        }
      }
      if (!controller.current?.signal.aborted) throw new Error('重启时间较长，请稍后刷新页面')
    } catch (e) {
      if (!controller.current?.signal.aborted) {
        setStatus(message(e))
        setBack(true)
      }
    } finally {
      watching.current = false
      busyRef.current = false
      setBusy(false)
      setRefreshPaused(false)
      setWaiting(false)
      if (recheck.current) {
        recheck.current = false
        void check(true)
      }
    }
  }
  useEffect(() => {
    const refresh = () => {
      checkedRef.current = false
      void check(true)
    }
    window.addEventListener('update-channel-changed', refresh)
    return () => window.removeEventListener('update-channel-changed', refresh)
  }, [])
  useEffect(() => {
    controller.current = new AbortController()
    void local()
      .then((data) => {
        setReady(true)
        if (data.job && ['running', 'waiting'].includes(data.job.status)) void watch(data.job)
        else if (openRef.current && !checkedRef.current) void check()
        else if (data.repoConfigured && data.mode === 'docker')
          void pause(1000).then(() => {
            if (!checkedRef.current) void check()
          })
      })
      .catch((e) => {
        if (!controller.current?.signal.aborted) setError(message(e))
      })
    return () => {
      controller.current?.abort()
      for (const [timer, resolve] of timers.current) {
        clearTimeout(timer)
        resolve()
      }
      timers.current.clear()
      setRefreshPaused(false)
    }
  }, [])
  useEffect(() => {
    if (!open) return
    const position = () => {
      const rect = pill.current?.getBoundingClientRect()
      const node = panel.current
      if (!rect || !node) return
      const width = Math.min(300, innerWidth - 32),
        top = Math.min(rect.bottom + 6, innerHeight - 16)
      node.style.left = `${Math.max(16, Math.min(rect.left, innerWidth - width - 16))}px`
      node.style.top = `${Math.max(0, top)}px`
      node.style.maxHeight = `${Math.max(0, innerHeight - top - 16)}px`
    }
    const close = () => {
      setOpen(false)
      pill.current?.focus()
    }
    const click = (event: MouseEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !pill.current?.contains(event.target as Node)
      )
        close()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    position()
    panel.current?.focus()
    window.addEventListener('resize', position)
    document.addEventListener('click', click)
    document.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('resize', position)
      document.removeEventListener('click', click)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  useEffect(() => {
    if (notes.current && !expanded)
      setTruncated(notes.current.scrollHeight > notes.current.clientHeight)
  }, [info.latest, open, expanded])
  const available = Boolean(info.hasUpdate && info.current !== 'dev' && info.target)
  let badge = 'info',
    description = checked ? '已是最新版本' : '尚未检查更新',
    detail = ''
  if (!ready) description = '正在读取版本信息…'
  else if (info.mode === 'unsupported') {
    description = '当前部署方式不支持在线更新'
    detail = '请在服务器执行 update.sh'
  } else if (!info.repoConfigured) {
    description = '未配置更新源'
    detail = '在 .env 设置 WORKLING_UPDATE_REPO'
  } else if (info.releaseError) {
    badge = 'warning'
    description = info.releaseError
  } else if (info.current === 'dev') {
    description = '开发版本，不参与版本比较'
    detail = info.latest ? `最新发布 ${info.latest.tag}` : ''
  } else if (available) {
    badge = 'arrow'
    description = `发现新版本 ${info.target!.version}`
  } else if (checked && info.latest) badge = 'check'
  else if (checked) description = '暂无可用发布'
  const prepare = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const data = await local()
      if (data.job && ['running', 'waiting'].includes(data.job.status)) {
        void watch(data.job)
        return
      }
      if (!data.target?.version) throw new Error('目标版本不可用，请重新检查更新')
      setSelection(data.target.version)
      setMode('drain')
      setError('')
      setProgress(false)
    } catch (e) {
      setError(message(e))
    } finally {
      if (!watching.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }
  const submit = async () => {
    if (!selection || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api<{ job: UpdateJob }>('update', { mode, target: selection })
      void watch(result.job)
    } catch (e) {
      setError(message(e))
    } finally {
      if (!watching.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }
  return (
    <>
      <button
        ref={pill}
        className="version-pill"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="version-popover"
        title={available ? `发现新版本 ${info.target!.version}` : '版本与更新'}
        onClick={() => {
          if (open) {
            setOpen(false)
            pill.current?.focus()
          } else {
            setOpen(true)
            if (ready && !checkedRef.current) void check()
          }
        }}
      >
        <span>{info.current}</span>
        <span className="dot" hidden={!available}></span>
      </button>
      {createPortal(
        <div
          ref={panel}
          id="version-popover"
          className="version-popover"
          role="dialog"
          aria-label="版本与更新"
          tabIndex={-1}
          hidden={!open}
        >
          <header className="version-head">
            <b>当前版本 · {info.channel === 'edge' ? '尝鲜版' : '稳定版'}</b>
            <button
              className={`version-icon-button${checking ? ' loading' : ''}`}
              type="button"
              aria-label="检查更新"
              disabled={!ready || checking || busy}
              onClick={() => void check(true)}
            >
              <Icon name="refresh" />
            </button>
          </header>
          <div className="version-body" aria-live="polite">
            <div className="version-number">
              <strong>
                {info.currentUrl ? (
                  <a href={info.currentUrl} target="_blank" rel="noopener noreferrer">
                    {info.current}
                  </a>
                ) : (
                  info.current
                )}
              </strong>
              <span className={`version-badge version-badge--${badge}`}>
                <Icon name={badge} />
              </span>
            </div>
            <p className="muted">{!available && info.note ? info.note : description}</p>
            <p className="small muted" hidden={!detail}>
              {detail}
            </p>
            <div
              hidden={
                info.channel === 'edge' || !info.latest || !(available || info.current === 'dev')
              }
            >
              <p ref={notes} className={`version-notes${expanded ? ' expanded' : ''}`}>
                {info.latest?.body || ''}
              </p>
              <button
                className="version-text-button"
                type="button"
                aria-expanded={expanded}
                hidden={
                  !info.latest?.body || (!truncated && info.latest.body.split('\n').length <= 4)
                }
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? '收起' : '更多'}
              </button>
            </div>
            <button
              className="button button--primary"
              type="button"
              hidden={
                !available ||
                info.mode !== 'docker' ||
                !info.repoConfigured ||
                Boolean(info.releaseError)
              }
              disabled={busy || Boolean(selection)}
              onClick={() => void prepare()}
            >
              更新到 {info.target?.version || ''}
            </button>
            <a
              className="version-link"
              target="_blank"
              rel="noopener noreferrer"
              hidden={!info.releasesUrl}
              href={info.releasesUrl || undefined}
            >
              <Icon name="github" />
              查看发布
            </a>
          </div>
          <section className="version-section" hidden={!selection}>
            <b>更新到 {selection}</b>
            <p className="small">会备份数据库并重启服务。</p>
            <fieldset hidden={!info.runningTasks}>
              <legend>执行方式</legend>
              <label>
                <input
                  type="radio"
                  name="version-mode"
                  value="drain"
                  checked={mode === 'drain'}
                  onChange={() => setMode('drain')}
                />
                等待 {info.runningTasks} 个运行中任务结束后更新（推荐）
              </label>
              <label>
                <input
                  type="radio"
                  name="version-mode"
                  value="now"
                  checked={mode === 'now'}
                  onChange={() => setMode('now')}
                />
                立即更新，中断运行中的任务
              </label>
            </fieldset>
            <div className="actions">
              <button
                ref={confirmButton}
                className="button button--primary"
                type="button"
                disabled={busy}
                onClick={() => void submit()}
              >
                确认更新
              </button>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setSelection('')}
              >
                取消
              </button>
            </div>
          </section>
          <section className="version-section" aria-live="polite" hidden={!progress}>
            <p>{status}</p>
            <pre id="version-logs">{logs}</pre>
            <button
              className="button"
              type="button"
              hidden={!waiting}
              onClick={async (event) => {
                const button = event.currentTarget
                button.disabled = true
                try {
                  const result = await api<{ job: UpdateJob }>('job/cancel', {})
                  setStatus(result.job.error || '已取消')
                } catch (e) {
                  setError(message(e))
                } finally {
                  button.disabled = false
                }
              }}
            >
              取消更新
            </button>
            <button
              className="button"
              type="button"
              hidden={!back}
              onClick={() => {
                setProgress(false)
                setError('')
              }}
            >
              返回
            </button>
          </section>
          <p className="version-error" role="alert" hidden={!error}>
            {error}
          </p>
          <footer className="version-footer">
            <p className="small muted" hidden={!info.lastSuccess}>
              {info.lastSuccess
                ? `上次更新：${info.lastSuccess.tag} · ${new Date(info.lastSuccess.at).toLocaleString()}`
                : ''}
            </p>
            <p className="small version-warning" hidden={!info.lastError}>
              {info.lastError || ''}
            </p>
          </footer>
        </div>,
        document.body,
      )}
    </>
  )
}
