import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { issues, repos, reviews, runs, sessions } from '../src/db/schema.ts'
import { createApp } from '../src/web/app.ts'
import { hashToken } from '../src/web/auth.ts'
import { clock, scenario } from './helpers/serve.ts'

test('评审和拆解配置通过管理接口分别保存，空字符串清除覆盖值', async () => {
  const s = await scenario()
  try {
    const app = createApp(s.db, { workspace: s.workspace })
    const now = new Date()
    s.db
      .insert(sessions)
      .values({
        id: hashToken('review-test'),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      .run()
    const request = (path: string, method: string, body: unknown) =>
      app.request(path, {
        method,
        headers: {
          host: 'localhost',
          cookie: 'workling_session=review-test',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    const repoApi = `/api/repos/${s.repo.id}/review`
    const setLevel = (level: unknown) => request(repoApi, 'PUT', { level })
    for (const value of ['comment', null]) {
      const invalid = await setLevel(value)
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: '评审级别无效' })
    }
    expect(s.db.select().from(repos).get()).toMatchObject({ reviewLevel: 'off', reviewSince: null })
    for (const level of ['shadow', 'off']) {
      const result = await setLevel(level)
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({ level })
      expect(s.db.select().from(repos).get()).toMatchObject({
        reviewLevel: level,
        reviewSince: expect.any(Date),
      })
    }
    const patch = (reviewModel: string, reviewEffort: string) =>
      request('/api/settings/pi', 'PATCH', { reviewModel, reviewEffort })
    expect((await patch('model-review', 'extra')).status).toBe(400)
    expect(await (await patch('model-review', 'xhigh')).json()).toMatchObject({
      reviewModel: 'model-review',
      reviewEffort: 'xhigh',
    })
    const patchPlan = (planModel: string | null, planEffort: string | null) =>
      request('/api/settings/pi', 'PATCH', { planModel, planEffort })
    expect((await patchPlan('model-plan', 'extra')).status).toBe(400)
    const saved = await patchPlan('model-plan', 'medium')
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      reviewModel: 'model-review',
      reviewEffort: 'xhigh',
      planModel: 'model-plan',
      planEffort: 'medium',
    })
    expect(await (await patch('', '')).json()).toMatchObject({
      reviewModel: null,
      reviewEffort: null,
      planModel: 'model-plan',
      planEffort: 'medium',
    })
    expect(await (await patchPlan('', null)).json()).toMatchObject({
      planModel: null,
      planEffort: null,
    })
  } finally {
    await s.dispose()
  }
})

test('评审 API 解析结论并处理损坏数据，评审日志可打开且不增加实现轮次', async () => {
  const s = await scenario()
  try {
    const now = new Date()
    const app = createApp(s.db, { workspace: s.workspace, now: () => now.getTime() })
    s.db
      .insert(sessions)
      .values({
        id: hashToken('review-test'),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      .run()
    const request = (path: string) =>
      app.request(path, { headers: { host: 'localhost', cookie: 'workling_session=review-test' } })
    const issue = await s.issue(42, 'done')
    const prUrl = 'https://github.com/a/b/pull/7'
    const branch = 'workling/42-issue'
    const delivery = s.db
      .insert(runs)
      .values({
        issueId: issue.id,
        kind: 'rework',
        worker: 'test',
        branch,
        startedAt: new Date(now.getTime() - 5000),
        endedAt: now,
      })
      .returning()
      .get()
    s.db
      .update(issues)
      .set({ lastRunId: delivery.id, prState: 'open', prUrl })
      .where(eq(issues.id, issue.id))
      .run()
    const overview = await (await request('/api/overview')).json()
    const list = await (await request('/api/issue-list')).json()
    const reviewRun = s.db
      .insert(runs)
      .values({ issueId: issue.id, kind: 'review', worker: 'test', startedAt: now, endedAt: now })
      .returning()
      .get()
    const input = {
      repoId: s.repo.id,
      issueId: issue.id,
      deliveryRunId: delivery.id,
      prUrl,
      branch,
      headSha: 'f'.repeat(40),
      partial: true,
      createdAt: clock,
      endedAt: now,
    }
    const checks = [{ command: 'bun test', passed: true, detail: 'passed' }]
    const acceptance = [{ item: '用例通过', met: 'yes', evidence: 'bun test' }]
    const findings = [
      {
        severity: 'minor',
        path: null,
        line: null,
        scenario: '空列表',
        body: '<b>说明</b>',
        known: false,
      },
    ]
    const valid = s.db
      .insert(reviews)
      .values({
        ...input,
        status: 'done',
        verdict: 'pass',
        summary: '总结',
        runId: reviewRun.id,
        checks: JSON.stringify(checks),
        acceptance: JSON.stringify(acceptance),
        findings: JSON.stringify(findings),
      })
      .returning()
      .get()
    const corrupt = s.db
      .insert(reviews)
      .values({
        ...input,
        deliveryRunId: delivery.id + 100,
        status: 'failed',
        checks: '{',
        acceptance: '{"item":[]}',
        findings: '[null]',
      })
      .returning()
      .get()
    const response = await request(`/api/issues/${issue.id}/reviews`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject([
      { id: corrupt.id, checks: [], acceptance: [], findings: [] },
      {
        id: valid.id,
        status: 'done',
        verdict: 'pass',
        checks,
        acceptance,
        findings,
        runId: reviewRun.id,
        deliveryRunId: delivery.id,
        partial: true,
        headSha: input.headSha,
      },
    ])
    expect((await request('/api/issues/999/reviews')).status).toBe(404)
    expect(await (await request('/api/overview')).json()).toEqual(overview)
    expect(await (await request('/api/issue-list')).json()).toEqual(list)
    const history = await (await request(`/api/issues/${issue.id}/runs`)).json()
    expect(history.map((row: { id: number }) => row.id)).toEqual([delivery.id])
    expect((await request(`/runs/${reviewRun.id}/log`)).status).toBe(200)
    const logDetail = await request(`/api/runs/${reviewRun.id}/detail`)
    expect(logDetail.status).toBe(200)
    expect(await logDetail.json()).toMatchObject({
      issue: { branch, stage: 'review' },
      runs: [
        { id: delivery.id, kind: 'rework' },
        { id: reviewRun.id, kind: 'review' },
      ],
    })
  } finally {
    await s.dispose()
  }
})
