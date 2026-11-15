import { readExecutorSettings } from '../../config/executor.ts'
import { Hono } from 'hono'
import { readPiSettings } from '../../config/pi.ts'
import type { Context } from 'hono'
import type { Child } from 'hono/jsx'
import { Shell } from '../views/shell.tsx'
import { getWebBundle } from '../bundle.ts'
import { readVersion } from '../../runtime/version.ts'
import * as Value from 'typebox/value'
import { shellSchema, type ShellData } from '../shell.ts'
import { OverviewPage } from '../views/overview.tsx'
import { IssuesPage } from '../views/issues.tsx'
import { SettingsPage } from '../views/settings.tsx'
import { ReposPage } from '../views/repos.tsx'
import { RepoPage } from '../views/repo.tsx'
import { IssuePage } from '../views/issue.tsx'
import { RunLogPage } from '../views/run-log.tsx'
import { LoginPage } from '../views/login.tsx'
import { NotFoundPage } from '../views/not-found.tsx'

import { pageData } from '../data.ts'
import type { AppDeps } from '../app.ts'
import { responsePi, repoId, html, headers } from '../response.ts'

async function render(
  c: Context,
  page: {
    title: string
    active: string
    sidebar: unknown
    children: Child
    refresh?: boolean
  },
  status: 200 | 404,
) {
  if (c.req.header('X-Workling-Fragment') === '1') {
    return c.body(String(page.children), status, {
      ...headers,
      Vary: 'X-Workling-Fragment',
      'X-Workling-Title': encodeURIComponent(page.title),
      'X-Workling-Active': page.active,
      'X-Workling-Refresh': page.refresh ? '15' : '',
    })
  }
  return c.body(html(Shell(await getWebBundle())), status, {
    ...headers,
    Vary: 'X-Workling-Fragment',
  })
}

export function pagesRoutes(deps: AppDeps): Hono {
  const { db, options } = deps
  const now = options.now ?? Date.now
  const data = () => pageData(db, now(), options.status?.())
  const app = new Hono()
  app.get('/api/shell', (c) => {
    const sidebar = data()
    const status = sidebar.status
    const body: ShellData = {
      version: readVersion(),
      repos: sidebar.repos.map(({ id, ref, enabled }) => ({
        id,
        ref,
        enabled,
        open: sidebar.issues.filter(
          (issue) => issue.repoId === id && ['queued', 'running', 'failed'].includes(issue.status),
        ).length,
      })),
      failed: sidebar.issues.filter((issue) => issue.status === 'failed').length,
      running: sidebar.issues.filter((issue) => issue.status === 'running').length,
      concurrency: sidebar.concurrency,
      watch: status
        ? {
            worker: status.worker,
            interval: status.interval,
            lastPollAt: status.lastPollAt?.toISOString() ?? null,
            lastPollError: status.lastPollError,
          }
        : null,
      now: new Date(sidebar.now).toISOString(),
    }
    if (!Value.Check(shellSchema, body)) throw new Error('侧栏数据无效')
    return c.json(body, 200, { 'Cache-Control': 'no-store' })
  })
  app.get('/', (c) => {
    const sidebar = data()
    return render(
      c,
      {
        title: '概览',
        active: 'overview',
        sidebar,
        refresh: true,
        children: OverviewPage({ data: sidebar }),
      },
      200,
    )
  })
  app.get('/issues', (c) => {
    const sidebar = data()
    return render(
      c,
      {
        title: '任务',
        active: 'issues',
        sidebar,
        children: IssuesPage({
          data: sidebar,
          filter: c.req.query('status') ?? 'all',
          repo: c.req.query('repo') ?? '',
          q: (c.req.query('q') ?? '').trim(),
        }),
      },
      200,
    )
  })
  app.get('/login', (c) => c.body(html(LoginPage()), 200, headers))
  app.get('/settings', (c) => {
    const sidebar = data()
    return render(
      c,
      {
        title: '设置',
        active: 'settings',
        sidebar,
        children: SettingsPage({
          data: sidebar,
          pi: responsePi(readPiSettings(db)),
          executor: readExecutorSettings(db),
          notice: c.req.query('notice') ?? '',
          startup: options.startup,
        }),
      },
      200,
    )
  })
  app.get('/repos', (c) => {
    const sidebar = data()
    return render(
      c,
      {
        title: '仓库',
        active: 'repos',
        sidebar,
        children: ReposPage({ data: sidebar, notice: c.req.query('notice') ?? '' }),
      },
      200,
    )
  })
  app.get('/repos/:id', (c) => {
    const sidebar = data()
    const id = repoId(c.req.param('id'))
    const found = id !== undefined && sidebar.repos.some((r) => r.id === id)
    return render(
      c,
      {
        title: found ? '仓库详情' : '页面不存在',
        active: found ? 'repos' : '',
        sidebar,
        children: found
          ? RepoPage({ data: sidebar, id, filter: c.req.query('status') ?? 'all' })
          : NotFoundPage(),
      },
      found ? 200 : 404,
    )
  })
  app.get('/issues/:id', (c) => {
    const sidebar = data()
    const id = repoId(c.req.param('id'))
    const issue = sidebar.issues.find((i) => i.id === id)
    return render(
      c,
      {
        title: issue ? 'Issue 详情' : '页面不存在',
        active: issue ? 'issues' : '',
        sidebar,
        children: issue ? IssuePage({ data: sidebar, issue }) : NotFoundPage(),
      },
      issue ? 200 : 404,
    )
  })
  app.get('/runs/:id/log', (c) => {
    const sidebar = data()
    const id = repoId(c.req.param('id'))
    const issue = sidebar.issues.find((item) => item.runs.some((run) => run.id === id))
    const run = issue?.runs.find((item) => item.id === id)
    return render(
      c,
      {
        title: run ? '执行日志' : '页面不存在',
        active: run ? 'issues' : '',
        sidebar,
        children: issue && run ? RunLogPage({ data: sidebar, issue, run }) : NotFoundPage(),
      },
      run ? 200 : 404,
    )
  })
  return app
}
