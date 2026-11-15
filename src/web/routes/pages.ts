import { readExecutorSettings } from '../../config/executor.ts'
import { Hono } from 'hono'
import { readPiSettings } from '../../config/pi.ts'
import { Layout } from '../views/layout.tsx'
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

export function pagesRoutes(deps: AppDeps): Hono {
  const { db, options } = deps
  const now = options.now ?? Date.now
  const data = () => pageData(db, now(), options.status?.())
  const app = new Hono()
  app.get('/', (c) => {
    const sidebar = data()
    return c.body(
      html(
        Layout({
          title: '概览',
          active: 'overview',
          sidebar,
          refresh: true,
          children: OverviewPage({ data: sidebar }),
        }),
      ),
      200,
      headers,
    )
  })
  app.get('/issues', (c) => {
    const sidebar = data()
    return c.body(
      html(
        Layout({
          title: '任务',
          active: 'issues',
          sidebar,
          children: IssuesPage({
            data: sidebar,
            filter: c.req.query('status') ?? 'all',
            repo: c.req.query('repo') ?? '',
            q: (c.req.query('q') ?? '').trim(),
          }),
        }),
      ),
      200,
      headers,
    )
  })
  app.get('/login', (c) => c.body(html(LoginPage()), 200, headers))
  app.get('/settings', (c) => {
    const sidebar = data()
    return c.body(
      html(
        Layout({
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
        }),
      ),
      200,
      headers,
    )
  })
  app.get('/repos', (c) => {
    const sidebar = data()
    return c.body(
      html(
        Layout({
          title: '仓库',
          active: 'repos',
          sidebar,
          children: ReposPage({ data: sidebar, notice: c.req.query('notice') ?? '' }),
        }),
      ),
      200,
      headers,
    )
  })
  app.get('/repos/:id', (c) => {
    const sidebar = data()
    const id = repoId(c.req.param('id'))
    const found = id !== undefined && sidebar.repos.some((r) => r.id === id)
    return c.body(
      html(
        Layout({
          title: found ? '仓库详情' : '页面不存在',
          active: found ? 'repos' : '',
          sidebar,
          children: found
            ? RepoPage({ data: sidebar, id, filter: c.req.query('status') ?? 'all' })
            : NotFoundPage(),
        }),
      ),
      found ? 200 : 404,
      headers,
    )
  })
  app.get('/issues/:id', (c) => {
    const sidebar = data()
    const id = repoId(c.req.param('id'))
    const issue = sidebar.issues.find((i) => i.id === id)
    return c.body(
      html(
        Layout({
          title: issue ? 'Issue 详情' : '页面不存在',
          active: issue ? 'issues' : '',
          sidebar,
          children: issue ? IssuePage({ data: sidebar, issue }) : NotFoundPage(),
        }),
      ),
      issue ? 200 : 404,
      headers,
    )
  })
  app.get('/runs/:id/log', (c) => {
    const sidebar = data()
    const id = repoId(c.req.param('id'))
    const issue = sidebar.issues.find((item) => item.runs.some((run) => run.id === id))
    const run = issue?.runs.find((item) => item.id === id)
    return c.body(
      html(
        Layout({
          title: run ? '执行日志' : '页面不存在',
          active: run ? 'issues' : '',
          sidebar,
          children: issue && run ? RunLogPage({ data: sidebar, issue, run }) : NotFoundPage(),
        }),
      ),
      run ? 200 : 404,
      headers,
    )
  })
  return app
}
