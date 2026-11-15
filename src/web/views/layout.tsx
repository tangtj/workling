import { readVersion } from '../../runtime/version.ts'
import type { Child } from 'hono/jsx'
import type { PageData } from '../data.ts'
import { secondsAgo } from './format.ts'
import { themeScript } from './theme.ts'

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
        <title>{title} · Workling</title>
        <script dangerouslySetInnerHTML={{ __html: themeScript }}></script>
        <link rel="stylesheet" href="/style.css" />
        <script src="/app.js" defer></script>
        <script src="/version.js" defer></script>
      </head>
      <body data-page={active} data-autorefresh={refresh ? '15' : undefined}>
        <div class="shell">
          <aside class="sidebar">
            <div class="brand">
              <a class="brand-mark" href="/" aria-label="Workling 首页">
                W
              </a>
              <div>
                <a href="/">
                  <b>Workling</b>
                </a>
                <button
                  id="version-pill"
                  class="version-pill"
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded="false"
                  aria-controls="version-popover"
                  data-current={readVersion()}
                >
                  <span id="version-label">{readVersion()}</span>
                  <span class="dot" hidden></span>
                </button>
              </div>
            </div>
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
              <button
                id="theme-toggle"
                class="button theme-toggle"
                type="button"
                aria-label="主题：跟随系统"
                title="主题：跟随系统"
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
                  <path id="theme-icon" d="M3 4h18v13H3zM8 21h8M12 17v4" />
                </svg>
              </button>
              <button id="logout" class="button button--wide" type="button">
                退出登录
              </button>
            </div>
          </aside>
          <main class="main">{children}</main>
        </div>
        <VersionPopover />
      </body>
    </html>
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
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}

function VersionPopover() {
  return (
    <div
      id="version-popover"
      class="version-popover"
      role="dialog"
      aria-label="版本与更新"
      tabindex={-1}
      hidden
    >
      <header class="version-head">
        <b>当前版本</b>
        <button id="version-check" class="version-icon-button" type="button" aria-label="检查更新">
          <VersionIcon name="refresh" />
        </button>
      </header>
      <div class="version-body" aria-live="polite">
        <div class="version-number">
          <strong id="version-current">{readVersion()}</strong>
          <span id="version-badge" class="version-badge">
            {['check', 'arrow', 'info', 'warning'].map((name) => (
              <span data-version-icon={name} hidden={name !== 'info'}>
                <VersionIcon name={name} />
              </span>
            ))}
          </span>
        </div>
        <p id="version-description" class="muted">
          正在读取版本信息…
        </p>
        <p id="version-detail" class="small muted" hidden></p>
        <div id="version-release" hidden>
          <p id="version-notes" class="version-notes"></p>
          <button
            id="version-more"
            class="version-text-button"
            type="button"
            aria-expanded="false"
            hidden
          >
            更多
          </button>
        </div>
        <button id="version-update" class="button button--primary" type="button" hidden></button>
        <a id="version-link" class="version-link" target="_blank" rel="noopener noreferrer" hidden>
          <VersionIcon name="github" />
          查看发布
        </a>
      </div>
      <section id="version-confirmation" class="version-section" hidden>
        <b id="version-confirm-title"></b>
        <p id="version-confirm-description" class="small"></p>
        <fieldset id="version-modes" hidden>
          <legend>执行方式</legend>
          <label>
            <input type="radio" name="version-mode" value="drain" checked />
            <span id="version-drain-label"></span>
          </label>
          <label>
            <input type="radio" name="version-mode" value="now" />
            立即更新，中断运行中的任务
          </label>
        </fieldset>
        <div class="actions">
          <button id="version-confirm" class="button button--primary" type="button">
            确认更新
          </button>
          <button id="version-dismiss" class="button" type="button">
            取消
          </button>
        </div>
      </section>
      <section id="version-progress" class="version-section" aria-live="polite" hidden>
        <p id="version-status"></p>
        <pre id="version-logs"></pre>
        <button id="version-cancel" class="button" type="button" hidden>
          取消更新
        </button>
        <button id="version-back" class="button" type="button" hidden>
          返回
        </button>
      </section>
      <p id="version-error" class="version-error" role="alert" hidden></p>
      <footer class="version-footer">
        <p id="version-last-success" class="small muted" hidden></p>
        <p id="version-last-error" class="small version-warning" hidden></p>
      </footer>
    </div>
  )
}
