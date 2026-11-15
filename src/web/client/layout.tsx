import { useEffect, useState } from 'react'
import { Link, Outlet, ScrollRestoration, useLocation, useOutletContext } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import * as Value from 'typebox/value'
import { shellSchema, type ShellData } from '../shell.ts'
import { readResponse, loadVersion, type Active } from './legacy.ts'

export const shellKey = ['shell']
async function fetchShell({ signal }: { signal: AbortSignal }): Promise<ShellData> {
  const response = await readResponse('/api/shell', { signal })
  if (!response.ok) throw new Error('加载侧栏失败')
  const data: unknown = await response.json()
  if (!Value.Check(shellSchema, data)) throw new Error('侧栏数据无效')
  return data
}

function secondsAgo(at: string, now: string) {
  const seconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(at)) / 1000))
  return seconds < 60
    ? `${seconds} 秒前`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟前`
      : `${Math.floor(seconds / 3600)} 小时前`
}

function useTheme() {
  const [mode, setMode] = useState(() => {
    try {
      const stored = localStorage.getItem('workling-theme')
      return stored === 'light' ? 1 : stored === 'dark' ? 2 : 0
    } catch {
      return 0
    }
  })
  const modes = ['system', 'light', 'dark']
  const labels = ['跟随系统', '浅色', '深色']
  const icons = [
    'M3 4h18v13H3zM8 21h8M12 17v4',
    'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
    'M20 15.5A8 8 0 0 1 8.5 4 8 8 0 1 0 20 15.5z',
  ]
  useEffect(() => {
    if (mode === 0) document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', modes[mode]!)
    // 强制主题时同步 color-scheme，CSS 加载前的画布颜色才与所选主题一致。
    document.documentElement.style.colorScheme = mode === 0 ? '' : modes[mode]!
  }, [mode])
  return {
    mode,
    labels,
    icons,
    cycle() {
      const next = (mode + 1) % 3
      try {
        localStorage.setItem('workling-theme', modes[next]!)
        setMode(next)
      } catch {
        setMode(0)
      }
    },
  }
}

async function logout() {
  try {
    const response = await readResponse('/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) throw new Error('退出登录失败')
    location.assign('/login')
  } catch (error) {
    alert(error instanceof Error ? error.message : '退出登录失败')
  }
}

type LayoutContext = { setActive: (active: Active) => void }
export const usePageLayout = () => useOutletContext<LayoutContext>()

export function Layout() {
  const location = useLocation()
  const [active, setActive] = useState<Active>('')
  const theme = useTheme()
  const shell = useQuery({ queryKey: shellKey, queryFn: fetchShell, refetchInterval: 15000 })
  useEffect(() => {
    void shell.refetch()
  }, [location.key])
  const sidebar = shell.data
  useEffect(() => {
    if (!sidebar) return
    let disposed = false
    let destroy: (() => void) | undefined
    void loadVersion()
      .then((module) => {
        if (!disposed) destroy = module.init()
      })
      .catch(() => {})
    return () => {
      disposed = true
      destroy?.()
    }
  }, [Boolean(sidebar)])
  return (
    <>
      <div className="shell">
        {sidebar ? (
          <>
            <aside className="sidebar">
              <div className="brand">
                <Link className="brand-mark" to="/" aria-label="Workling 首页">
                  W
                </Link>
                <div>
                  <Link to="/">
                    <b>Workling</b>
                  </Link>
                  <button
                    id="version-pill"
                    className="version-pill"
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded="false"
                    aria-controls="version-popover"
                    data-current={sidebar.version}
                  >
                    <span id="version-label">{sidebar.version}</span>
                    <span className="dot" hidden></span>
                  </button>
                </div>
              </div>
              <nav className="nav">
                {(['overview', 'issues', 'repos', 'settings'] as const).map((key, index) => (
                  <Link
                    key={key}
                    className={active === key ? 'on' : ''}
                    to={['/', '/issues', '/repos', '/settings'][index]}
                  >
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
                      {key === 'overview' ? (
                        <path d="M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-4H4z" />
                      ) : key === 'issues' ? (
                        <>
                          <circle cx="12" cy="12" r="8" />
                          <circle cx="12" cy="12" r="2" />
                        </>
                      ) : key === 'repos' ? (
                        <>
                          <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" />
                          <path d="M5 17a3 3 0 0 1 3-3h11" />
                        </>
                      ) : (
                        <>
                          <circle cx="12" cy="12" r="3" />
                          <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
                        </>
                      )}
                    </svg>
                    {['概览', '任务', '仓库', '设置'][index]}
                    {key === 'repos' && <span className="count">{sidebar.repos.length}</span>}
                    {key === 'issues' && sidebar.failed > 0 && (
                      <span className="count hot">{sidebar.failed} 失败</span>
                    )}
                  </Link>
                ))}
              </nav>
              <div className="sidebar-label">已启用仓库</div>
              <div className="repo-nav">
                {sidebar.repos
                  .filter((r) => r.enabled)
                  .map((r) => (
                    <Link key={r.id} to={`/issues?repo=${r.id}`}>
                      <span>{r.ref.replace(/^github:/, '')}</span>
                      <span>{r.open}</span>
                    </Link>
                  ))}
              </div>
              <div className="sidebar-bottom">
                <div className={`watch-card${sidebar.watch?.lastPollError ? ' warn' : ''}`}>
                  {sidebar.watch ? (
                    <>
                      <div>
                        <span className="dot dot--done"></span> watch 运行中
                      </div>
                      <div>
                        {sidebar.watch.worker} · 每 {sidebar.watch.interval} 秒轮询
                      </div>
                      <div>
                        上次轮询{' '}
                        {sidebar.watch.lastPollAt
                          ? secondsAgo(sidebar.watch.lastPollAt, sidebar.now)
                          : '—'}
                      </div>
                      <div className="watch-slots">
                        名额 {sidebar.running} / {sidebar.concurrency}
                      </div>
                      <div className="slots-mini">
                        {Array.from(
                          { length: Math.max(sidebar.running, sidebar.concurrency) },
                          (_, index) => (
                            <span
                              key={index}
                              className={`slot-pip${index < sidebar.running ? ' busy' : ''}`}
                            ></span>
                          ),
                        )}
                      </div>
                      {sidebar.watch.lastPollError && (
                        <div className="error-text">{sidebar.watch.lastPollError}</div>
                      )}
                    </>
                  ) : (
                    <div>
                      <span className="dot"></span> watch 状态未知
                    </div>
                  )}
                </div>
                <button
                  id="theme-toggle"
                  className="button theme-toggle"
                  type="button"
                  aria-label={`主题：${theme.labels[theme.mode]}`}
                  title={`主题：${theme.labels[theme.mode]}`}
                  onClick={theme.cycle}
                >
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
                    <path id="theme-icon" d={theme.icons[theme.mode]} />
                  </svg>
                </button>
                <button id="logout" onClick={logout} className="button button--wide" type="button">
                  退出登录
                </button>
              </div>
            </aside>
          </>
        ) : (
          <aside className="sidebar">
            <b>Workling</b>
            {shell.isError ? (
              <p role="alert">
                加载侧栏失败{' '}
                <button type="button" className="button" onClick={() => void shell.refetch()}>
                  重试
                </button>
              </p>
            ) : (
              <p>加载中…</p>
            )}
          </aside>
        )}
        <main className="main">
          <Outlet context={{ setActive } satisfies LayoutContext} />
        </main>
      </div>
      {sidebar && <VersionPopover version={sidebar.version} />}
      <ScrollRestoration />
    </>
  )
}

function VersionIcon({ name }: { name: string }) {
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

function VersionPopover({ version }: { version: string }) {
  return (
    <div
      id="version-popover"
      className="version-popover"
      role="dialog"
      aria-label="版本与更新"
      tabIndex={-1}
      hidden
    >
      <header className="version-head">
        <b>当前版本</b>
        <button
          id="version-check"
          className="version-icon-button"
          type="button"
          aria-label="检查更新"
        >
          <VersionIcon name="refresh" />
        </button>
      </header>
      <div className="version-body" aria-live="polite">
        <div className="version-number">
          <strong id="version-current">{version}</strong>
          <span id="version-badge" className="version-badge">
            {['check', 'arrow', 'info', 'warning'].map((name) => (
              <span key={name} data-version-icon={name} hidden={name !== 'info'}>
                <VersionIcon name={name} />
              </span>
            ))}
          </span>
        </div>
        <p id="version-description" className="muted">
          正在读取版本信息…
        </p>
        <p id="version-detail" className="small muted" hidden></p>
        <div id="version-release" hidden>
          <p id="version-notes" className="version-notes"></p>
          <button
            id="version-more"
            className="version-text-button"
            type="button"
            aria-expanded="false"
            hidden
          >
            更多
          </button>
        </div>
        <button
          id="version-update"
          className="button button--primary"
          type="button"
          hidden
        ></button>
        <a
          id="version-link"
          className="version-link"
          target="_blank"
          rel="noopener noreferrer"
          hidden
        >
          <VersionIcon name="github" />
          查看发布
        </a>
      </div>
      <section id="version-confirmation" className="version-section" hidden>
        <b id="version-confirm-title"></b>
        <p id="version-confirm-description" className="small"></p>
        <fieldset id="version-modes" hidden>
          <legend>执行方式</legend>
          <label>
            <input type="radio" name="version-mode" value="drain" defaultChecked />
            <span id="version-drain-label"></span>
          </label>
          <label>
            <input type="radio" name="version-mode" value="now" />
            立即更新，中断运行中的任务
          </label>
        </fieldset>
        <div className="actions">
          <button id="version-confirm" className="button button--primary" type="button">
            确认更新
          </button>
          <button id="version-dismiss" className="button" type="button">
            取消
          </button>
        </div>
      </section>
      <section id="version-progress" className="version-section" aria-live="polite" hidden>
        <p id="version-status"></p>
        <pre id="version-logs"></pre>
        <button id="version-cancel" className="button" type="button" hidden>
          取消更新
        </button>
        <button id="version-back" className="button" type="button" hidden>
          返回
        </button>
      </section>
      <p id="version-error" className="version-error" role="alert" hidden></p>
      <footer className="version-footer">
        <p id="version-last-success" className="small muted" hidden></p>
        <p id="version-last-error" className="small version-warning" hidden></p>
      </footer>
    </div>
  )
}
