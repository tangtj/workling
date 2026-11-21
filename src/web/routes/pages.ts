import { repoTriage, triageOverview } from '../triage.ts'
import { feedback, triageRecords } from '../../db/schema.ts'
import { and, eq, asc } from 'drizzle-orm'
import { countAutoRounds, prNumberOf } from '../../serve/rework.ts'
import { failureReason } from '../issue-view.ts'
import { attentionStages } from '../stage.ts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { shellHtml } from '../shell-html.ts'
import { getWebBundle } from '../bundle.ts'
import { readVersion } from '../../runtime/version.ts'
import * as Value from 'typebox/value'
import { shellSchema, type ShellData } from '../shell.ts'
import { overviewSchema, type OverviewData } from '../overview.ts'

import { pageData, maskToken } from '../data.ts'
import { issueListSchema, type IssueListData } from '../issue-list.ts'
import { issueDetailSchema, type IssueDetailData } from '../issue-detail.ts'
import type { Issue } from '../data.ts'
import type { AppDeps } from '../app.ts'
import { repoId, headers } from '../response.ts'

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
      triagePending: triageOverview(db).pendingSuggestions,
      attention: sidebar.issues.filter((issue) => attentionStages.includes(issue.stage)).length,
      failed: sidebar.issues.filter((issue) => issue.status === 'failed').length,
      running: sidebar.issues.filter((issue) => issue.status === 'running').length,
      concurrency: sidebar.concurrency,
      watch: status
        ? {
            worker: status.worker,
            interval: status.interval,
            lastPollAt: status.lastPollAt?.toISOString() ?? null,
            lastPollError: status.lastPollError,
            workerError: status.workerError ?? null,
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
        ({
          id,
          repoId,
          number,
          title,
          status,
          stage,
          prUrl,
          prState,
          updatedAt,
          runs,
          lastRun,
        }) => ({
          id,
          repoId,
          number,
          title,
          status,
          stage,
          branch: lastRun?.branch ?? null,
          rounds: runs.length,
          prUrl,
          prState,
          updatedAt: updatedAt.toISOString(),
          runCount: runs.length,
          lastRun: lastRun && {
            kind: lastRun.kind,
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
  const detail = (issue: Issue, time: number, limit: number | null): IssueDetailData => ({
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
      stage: issue.stage,
      branch: issue.runs[0]?.branch ?? null,
      baseRef: issue.runs[0]?.baseRef ?? null,
      prUrl: issue.prUrl,
      prState: issue.prState,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
    },
    triage: db
      .select()
      .from(triageRecords)
      .where(and(eq(triageRecords.repoId, issue.repoId), eq(triageRecords.number, issue.number)))
      .orderBy(asc(triageRecords.triagedAt), asc(triageRecords.id))
      .all()
      .map((row) => ({
        id: row.id,
        decision: row.decision,
        llmDecision: row.llmDecision,
        missing: JSON.parse(row.missing) as string[],
        triagedAt: row.triagedAt.toISOString(),
        suggestedAt: row.suggestedAt?.toISOString() ?? null,
        suggestCommentUrl: row.suggestCommentUrl,
        autoQueuedAt: row.autoQueuedAt?.toISOString() ?? null,
      })),
    rework: {
      rounds: issue.prUrl
        ? countAutoRounds(
            prNumberOf(issue.prUrl),
            db.select().from(feedback).where(eq(feedback.issueId, issue.id)).all(),
            new Set(issue.runs.filter((run) => run.kind === 'rework').map((run) => run.id)),
          )
        : 0,
      limit,
    },
    runs: issue.runs.map((run) => ({
      id: run.id,
      worker: run.worker,
      branch: run.branch,
      kind: run.kind,
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
    const body = detail(issue, page.now, page.status?.reworkLimit ?? null)
    if (!Value.Check(issueDetailSchema, body)) throw new Error('Issue 详情数据无效')
    return c.json(body, 200, { 'Cache-Control': 'no-store' })
  })
  app.get('/api/runs/:id/detail', (c) => {
    const page = data()
    const id = repoId(c.req.param('id'))
    const issue = page.issues.find((item) => item.runs.some((run) => run.id === id))
    if (!issue) return c.json({ error: '执行记录不存在' }, 404)
    const body = detail(issue, page.now, page.status?.reworkLimit ?? null)
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
      kind: run.kind,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      exitCode: run.exitCode,
      error: run.error,
    })
    const rows = db.select().from(feedback).all()
    const attention: OverviewData['attention'] = []
    for (const issue of page.issues) {
      if (issue.stage !== 'failed' && issue.stage !== 'capped' && issue.stage !== 'review') continue
      const issueRows = rows.filter((row) => row.issueId === issue.id)
      const cappedAt = issueRows
        .filter((row) => row.status === 'capped')
        .map((row) => row.createdAt.getTime())
      const round = issue.lastRun
        ? issue.runs.filter(
            (run) =>
              run.startedAt < issue.lastRun!.startedAt ||
              (run.startedAt.getTime() === issue.lastRun!.startedAt.getTime() &&
                run.id <= issue.lastRun!.id),
          ).length
        : 0
      const count = countAutoRounds(
        prNumberOf(issue.prUrl),
        issueRows,
        new Set(issue.runs.filter((run) => run.kind === 'rework').map((run) => run.id)),
      )
      attention.push({
        kind: issue.stage,
        repoId: issue.repoId,
        repoRef: issue.repo.ref,
        number: issue.number,
        title: issue.title,
        issueId: issue.id,
        url: `https://${issue.repo.host}/${issue.repo.path}/issues/${issue.number}`,
        prUrl: issue.prUrl,
        logRunId: issue.stage === 'failed' ? (issue.lastRun?.id ?? null) : null,
        since: (issue.stage === 'capped' && cappedAt.length
          ? new Date(Math.max(...cappedAt))
          : (issue.lastRun?.endedAt ?? issue.updatedAt)
        ).toISOString(),
        reason:
          issue.stage === 'failed'
            ? `第 ${round} 轮${issue.lastRun?.kind === 'rework' ? '返工' : '实现'} · ${failureReason(issue).label}`
            : issue.stage === 'capped'
              ? `已自动返工 ${count} / ${page.status?.reworkLimit ?? '—'} 轮，PR 上的 Request changes 不再自动处理`
              : 'PR 已打开，等待 review',
      })
    }
    for (const repo of page.repos.filter((repo) => repo.enabled)) {
      for (const record of repoTriage(db, repo).records) {
        if (record.followUp !== 'pending' || !record.suggestedAt) continue
        attention.push({
          kind: 'needs_info',
          repoId: repo.id,
          repoRef: repo.ref,
          number: record.number,
          title: record.title,
          issueId: null,
          url: `https://${repo.host}/${repo.path}/issues/${record.number}`,
          prUrl: null,
          since: record.suggestedAt,
          reason: `已评论缺少：${record.missing.join('、')}，等作者补充`,
          logRunId: null,
        })
      }
    }
    attention.sort((a, b) => a.since.localeCompare(b.since))
    const alerts: OverviewData['alerts'] = []
    if (page.status?.lastPollError)
      alerts.push({ kind: 'poll', message: `轮询失败：${page.status.lastPollError}` })
    if (page.status?.workerError)
      alerts.push({
        kind: 'worker',
        message: `${page.status.workerError}；已暂停拉起新任务，排队中的 Issue 会等待。`,
      })
    const body: OverviewData = {
      alerts,
      attention: attention.slice(0, 50),
      reworked: page.issues
        .flatMap((issue) => issue.runs)
        .filter((run) => run.kind === 'rework' && recent(run)).length,
      now: new Date(page.now).toISOString(),
      repos: { total: page.repos.length, enabled: page.repos.filter((r) => r.enabled).length },
      concurrency: page.concurrency,
      watch: page.status
        ? {
            worker: page.status.worker,
            timeout: page.status.timeout,
            lastPollAt: page.status.lastPollAt?.toISOString() ?? null,
            lastPollError: page.status.lastPollError,
            workerError: page.status.workerError ?? null,
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
          round: i.lastRun
            ? i.runs.filter(
                (run) =>
                  run.startedAt < i.lastRun!.startedAt ||
                  (run.startedAt.getTime() === i.lastRun!.startedAt.getTime() &&
                    run.id <= i.lastRun!.id),
              ).length
            : 0,
          lastRun: i.lastRun ? serialize(i.lastRun) : null,
          runs: i.runs.filter((r) => r.id === i.lastRun?.id || recent(r)).map(serialize),
        })),
    }
    if (!Value.Check(overviewSchema, body)) throw new Error('概览数据无效')
    return c.json(body, 200, { 'Cache-Control': 'no-store' })
  })
  const shell = async (c: Context, status: 200 | 404) =>
    c.body(shellHtml(await getWebBundle()), status, headers)
  app.get('/', (c) => shell(c, 200))
  app.get('/triage', (c) => shell(c, 200))
  app.get('/issues', (c) => shell(c, 200))
  app.get('/login', async (c) => c.body(shellHtml(await getWebBundle(), true), 200, headers))
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
