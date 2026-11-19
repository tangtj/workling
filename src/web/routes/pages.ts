import { Hono } from 'hono'
import type { Context } from 'hono'
import { Shell } from '../views/shell.tsx'
import { getWebBundle } from '../bundle.ts'
import { readVersion } from '../../runtime/version.ts'
import * as Value from 'typebox/value'
import { shellSchema, type ShellData } from '../shell.ts'
import { overviewSchema, type OverviewData } from '../overview.ts'
import { LoginPage } from '../views/login.tsx'

import { pageData, maskToken } from '../data.ts'
import { issueListSchema, type IssueListData } from '../issue-list.ts'
import { issueDetailSchema, type IssueDetailData } from '../issue-detail.ts'
import type { Issue } from '../data.ts'
import type { AppDeps } from '../app.ts'
import { repoId, html, headers } from '../response.ts'

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
  const detail = (issue: Issue, time: number): IssueDetailData => ({
    now: new Date(time).toISOString(),
    issue: {
      id: issue.id,
      repoId: issue.repoId,
      repo: {
        ref: issue.repo.ref,
        platform: issue.repo.platform,
        host: issue.repo.host,
        path: issue.repo.path,
      },
      number: issue.number,
      title: issue.title,
      status: issue.status,
      prUrl: issue.prUrl,
      prState: issue.prState,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
    },
    runs: issue.runs.map((run) => ({
      id: run.id,
      worker: run.worker,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      exitCode: run.exitCode,
      error: run.error,
      summary: run.summary,
      reportResult: run.reportResult,
      logTail: run.logTail,
      taskDir: run.taskDir,
      pid: run.pid,
      container: run.container,
    })),
  })
  app.get('/api/issues/:id/detail', (c) => {
    const page = data()
    const id = repoId(c.req.param('id'))
    const issue = page.issues.find((item) => item.id === id)
    if (!issue) return c.json({ error: 'Issue 不存在' }, 404)
    const body = detail(issue, page.now)
    if (!Value.Check(issueDetailSchema, body)) throw new Error('Issue 详情数据无效')
    return c.json(body, 200, { 'Cache-Control': 'no-store' })
  })
  app.get('/api/runs/:id/detail', (c) => {
    const page = data()
    const id = repoId(c.req.param('id'))
    const issue = page.issues.find((item) => item.runs.some((run) => run.id === id))
    if (!issue) return c.json({ error: '执行记录不存在' }, 404)
    const body = detail(issue, page.now)
    if (!Value.Check(issueDetailSchema, body)) throw new Error('Issue 详情数据无效')
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
  app.get('/settings', (c) => shell(c, 200))
  app.get('/repos', (c) => shell(c, 200))
  app.get('/repos/:id', (c) => {
    const id = repoId(c.req.param('id'))
    return shell(c, id !== undefined && data().repos.some((r) => r.id === id) ? 200 : 404)
  })
  app.get('/issues/:id', (c) => {
    const id = repoId(c.req.param('id'))
    return shell(c, id !== undefined && data().issues.some((i) => i.id === id) ? 200 : 404)
  })
  app.get('/runs/:id/log', (c) => {
    const id = repoId(c.req.param('id'))
    const exists =
      id !== undefined && data().issues.some((issue) => issue.runs.some((run) => run.id === id))
    return shell(c, exists ? 200 : 404)
  })
  return app
}
