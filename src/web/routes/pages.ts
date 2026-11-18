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
import { overviewSchema, type OverviewData } from '../overview.ts'
import { SettingsPage } from '../views/settings.tsx'
import { ReposPage } from '../views/repos.tsx'
import { IssuePage } from '../views/issue.tsx'
import { RunLogPage } from '../views/run-log.tsx'
import { LoginPage } from '../views/login.tsx'
import { NotFoundPage } from '../views/not-found.tsx'

import { pageData, maskToken } from '../data.ts'
import { issueListSchema, type IssueListData } from '../issue-list.ts'
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
  app.get('/api/issue-list', (c) => {
    const page = data()
    const body: IssueListData = {
      now: new Date(page.now).toISOString(),
      repos: page.repos.map(({ id, ref, platform, host, path, enabled, token }) => ({
        id,
        ref,
        platform,
        host,
        path,
        enabled,
        tokenMask: maskToken(token),
      })),
      issues: page.issues.map(
        ({ id, repoId, number, title, status, prUrl, prState, updatedAt, runs, lastRun }) => ({
          id,
          repoId,
          number,
          title,
          status,
          prUrl,
          prState,
          updatedAt: updatedAt.toISOString(),
          runCount: runs.length,
          lastRun: lastRun && {
            startedAt: lastRun.startedAt.toISOString(),
            endedAt: lastRun.endedAt?.toISOString() ?? null,
            exitCode: lastRun.exitCode,
            error: lastRun.error,
          },
        }),
      ),
    }
    if (!Value.Check(issueListSchema, body)) throw new Error('任务列表数据无效')
    return c.json(body, 200, { 'Cache-Control': 'no-store' })
  })
  app.get('/api/overview', (c) => {
    const page = data()
    const recent = (run: (typeof page.issues)[number]['runs'][number]) =>
      run.endedAt !== null &&
      run.endedAt.getTime() >= page.now - 86400000 &&
      run.endedAt.getTime() <= page.now
    const serialize = (run: (typeof page.issues)[number]['runs'][number]) => ({
      id: run.id,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      exitCode: run.exitCode,
      error: run.error,
    })
    const body: OverviewData = {
      now: new Date(page.now).toISOString(),
      repos: { total: page.repos.length, enabled: page.repos.filter((r) => r.enabled).length },
      concurrency: page.concurrency,
      watch: page.status
        ? {
            worker: page.status.worker,
            timeout: page.status.timeout,
            lastPollAt: page.status.lastPollAt?.toISOString() ?? null,
            lastPollError: page.status.lastPollError,
          }
        : null,
      issues: page.issues
        .filter((i) => ['running', 'queued', 'failed'].includes(i.status) || i.runs.some(recent))
        .map((i) => ({
          id: i.id,
          repoId: i.repoId,
          repoRef: i.repo.ref,
          number: i.number,
          title: i.title,
          status: i.status,
          prUrl: i.prUrl,
          prState: i.prState,
          updatedAt: i.updatedAt.toISOString(),
          runCount: i.runs.length,
          lastRun: i.lastRun ? serialize(i.lastRun) : null,
          runs: i.runs.filter((r) => r.id === i.lastRun?.id || recent(r)).map(serialize),
        })),
    }
    if (!Value.Check(overviewSchema, body)) throw new Error('概览数据无效')
    return c.json(body, 200, { 'Cache-Control': 'no-store' })
  })
  const shell = async (c: Context, status: 200 | 404) =>
    c.body(html(Shell(await getWebBundle())), status, { ...headers, Vary: 'X-Workling-Fragment' })
  app.get('/', (c) => shell(c, 200))
  app.get('/issues', (c) => shell(c, 200))
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
    const id = repoId(c.req.param('id'))
    return shell(c, id !== undefined && data().repos.some((r) => r.id === id) ? 200 : 404)
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
