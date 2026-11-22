import { useEffect, useState } from 'react'
import { Link, Outlet, ScrollRestoration, useLocation, useOutletContext } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import * as Value from 'typebox/value'
import { shellSchema, type ShellData } from '../shell.ts'
import { readResponse, type Active } from './http.ts'
import { VersionPanel } from './version-panel.tsx'

export const shellKey = ['shell']
async function fetchShell({ signal }: { signal: AbortSignal }): Promise<ShellData> {
  const response = await readResponse('/api/shell', { signal })
  if (!response.ok) throw new Error('加载侧栏失败')
  const data: unknown = await response.json()
  if (!Value.Check(shellSchema, data)) throw new Error('侧栏数据无效')
  return data
}

function elapsedSeconds(at: string, now: string) {
  return Math.max(0, (Date.parse(now) - Date.parse(at)) / 1000)
}

// 距下次轮询的倒计时圆环：用负的 animation-delay 从已过去的时长处开始，
// 按服务端 now 计算已过时间，避免依赖浏览器时钟与服务端一致。
function PollRing({
  lastPollAt,
  now,
  interval,
}: {
  lastPollAt: string
  now: string
  interval: number
}) {
  const elapsed = elapsedSeconds(lastPollAt, now)
  return (
    <svg className="poll-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" pathLength="100" />
      <circle
        className="poll-ring-progress"
        cx="8"
        cy="8"
        r="6"
        pathLength="100"
        style={{ animationDuration: `${interval}s`, animationDelay: `-${elapsed}s` }}
      />
    </svg>
  )
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
  return (
    <>
      <div className="shell">
        {/* 品牌与导航不依赖接口数据，加载期间照常显示，避免侧栏先空后满地跳动 */}
        <aside className="sidebar">
          <div className="brand">
            <Link className="brand-mark" to="/" aria-label="Workling 首页">
              W
            </Link>
            <div>
              <Link to="/">
                <b>Workling</b>
              </Link>
              {sidebar && <VersionPanel version={sidebar.version} />}
            </div>
          </div>
          <nav className="nav">
            {(['overview', 'issues', 'triage', 'repos', 'settings'] as const).map((key, index) => (
              <Link
                key={key}
                className={active === key ? 'on' : ''}
                to={['/', '/issues', '/triage', '/repos', '/settings'][index]}
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
                  ) : key === 'triage' ? (
                    <path d="M4 5h16l-6 7v6l-4 2v-8z" />
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
                {['概览', '任务', '分诊', '仓库', '设置'][index]}
                {key === 'triage' && sidebar && sidebar.triagePending > 0 && (
                  <span className="count triage-warn">{sidebar.triagePending} 待补充</span>
                )}
                {key === 'repos' && sidebar && (
                  <span className="count">{sidebar.repos.length}</span>
                )}
                {key === 'issues' && sidebar && sidebar.attention > 0 && (
                  <span className="count hot">{sidebar.attention} 待处理</span>
                )}
              </Link>
            ))}
          </nav>
          {sidebar ? (
            <>
              {sidebar.repos.some((r) => r.enabled) && (
                <>
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
                </>
              )}
              <div className="sidebar-bottom">
                <div
                  className={`watch-card${sidebar.watch?.lastPollError || sidebar.watch?.workerError ? ' warn' : ''}`}
                >
                  {sidebar.watch ? (
                    <>
                      <div className="watch-head">
                        <span className="dot dot--done"></span>
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
                        {sidebar.watch.lastPollAt && (
                          <PollRing
                            // 每次轮询换 key 重建元素，让动画从新的起点开始
                            key={sidebar.watch.lastPollAt}
                            lastPollAt={sidebar.watch.lastPollAt}
                            now={sidebar.now}
                            interval={sidebar.watch.interval}
                          />
                        )}
                      </div>
                      {sidebar.watch.lastPollError && (
                        <div className="error-text">{sidebar.watch.lastPollError}</div>
                      )}
                      {sidebar.watch.workerError && (
                        <div className="error-text">{sidebar.watch.workerError}</div>
                      )}
                    </>
                  ) : (
                    <div>
                      <span className="dot"></span> watch 状态未知
                    </div>
                  )}
                </div>
                <div className="sidebar-actions">
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
                  <button
                    id="logout"
                    onClick={logout}
                    className="button button--wide"
                    type="button"
                  >
                    退出登录
                  </button>
                </div>
              </div>
            </>
          ) : (
            shell.isError && (
              <p role="alert">
                加载侧栏失败{' '}
                <button type="button" className="button" onClick={() => void shell.refetch()}>
                  重试
                </button>
              </p>
            )
          )}
        </aside>
        <main className="main">
          <Outlet context={{ setActive } satisfies LayoutContext} />
        </main>
      </div>
      <ScrollRestoration />
    </>
  )
}
