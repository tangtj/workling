import { readVersion } from '../../runtime/version.ts'
import type { Child } from 'hono/jsx'
import type { PageData } from '../data.ts'
import { secondsAgo } from './format.ts'

export function Layout({
  title,
  active,
  sidebar,
  children,
  refresh = false,
}: {
  title: string
  active: string
  sidebar: PageData
  children: Child
  refresh?: boolean
}) {
  const running = sidebar.issues.filter((i) => i.status === 'running').length
  const failed = sidebar.issues.filter((i) => i.status === 'failed').length
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} · workling</title>
        <link rel="stylesheet" href="/style.css" />
        <script src="/app.js" defer></script>
      </head>
      <body data-page={active} data-autorefresh={refresh ? '15' : undefined}>
        <div class="shell">
          <aside class="sidebar">
            <a class="brand" href="/">
              <span class="brand-mark">P</span>
              <div>
                <b>workling</b>
                <span>本机管理</span>
              </div>
            </a>
            <nav class="nav">
              {(['overview', 'issues', 'repos', 'settings'] as const).map((key, index) => (
                <a
                  class={active === key ? 'on' : ''}
                  href={['/', '/issues', '/repos', '/settings'][index]}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
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
                  {key === 'repos' && <span class="count">{sidebar.repos.length}</span>}
                  {key === 'issues' && failed > 0 && <span class="count hot">{failed} 失败</span>}
                </a>
              ))}
            </nav>
            <div class="sidebar-label">已启用仓库</div>
            <div class="repo-nav">
              {sidebar.repos
                .filter((r) => r.enabled)
                .map((r) => (
                  <a href={`/issues?repo=${r.id}`}>
                    <span>{r.ref.replace(/^github:/, '')}</span>
                    <span>
                      {
                        sidebar.issues.filter(
                          (i) =>
                            i.repoId === r.id && ['queued', 'running', 'failed'].includes(i.status),
                        ).length
                      }
                    </span>
                  </a>
                ))}
            </div>
            <div class="sidebar-bottom">
              <div class={`watch-card${sidebar.status?.lastPollError ? ' warn' : ''}`}>
                {sidebar.status ? (
                  <>
                    <div>
                      <span class="dot dot--done"></span> watch 运行中
                    </div>
                    <div>
                      {sidebar.status.worker} · 每 {sidebar.status.interval} 秒轮询
                    </div>
                    <div>
                      上次轮询{' '}
                      {sidebar.status.lastPollAt
                        ? secondsAgo(sidebar.status.lastPollAt, sidebar.now)
                        : '—'}
                    </div>
                    <div class="watch-slots">
                      名额 {running} / {sidebar.concurrency}
                    </div>
                    <div class="slots-mini">
                      {Array.from(
                        { length: Math.max(running, sidebar.concurrency) },
                        (_, index) => (
                          <span class={`slot-pip${index < running ? ' busy' : ''}`}></span>
                        ),
                      )}
                    </div>
                    {sidebar.status.lastPollError && (
                      <div class="error-text">{sidebar.status.lastPollError}</div>
                    )}
                  </>
                ) : (
                  <div>
                    <span class="dot"></span> watch 状态未知
                  </div>
                )}
              </div>
              <div class="small muted">版本 {readVersion()}</div>
              <button id="logout" class="button button--wide" type="button">
                退出登录
              </button>
            </div>
          </aside>
          <main class="main">{children}</main>
        </div>
      </body>
    </html>
  )
}
