import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePiSettings } from '../src/config/pi.ts'
import type { Review } from '../src/contract/out.ts'
import { writeResult } from '../src/contract/result.ts'
import { writeLlmSecrets } from '../src/contract/secrets.ts'
import { readSpec } from '../src/contract/spec.ts'
import { issues, repos, reviews, runs } from '../src/db/schema.ts'
import { launchQueued } from '../src/serve/launch.ts'
import { launchReviews, reconcileReviews, recoverOrphanReviews } from '../src/serve/review.ts'
import { localRemote } from './helpers/git.ts'
import { clock, fakeExecutor, scenario } from './helpers/serve.ts'

const branch = 'workling/42-issue'
const prUrl = 'https://github.com/a/b/pull/7'
const fixtureOutput: Review = {
  verdict: 'changes',
  summary: '检查通过，但有一项验收未满足。',
  checks: [{ command: 'bun test', passed: true, detail: '2 passed' }],
  acceptance: [{ item: '逆序输入返回零', met: 'no', evidence: '输出为 -2' }],
  findings: [
    {
      severity: 'blocker',
      path: 'src/task.ts',
      line: 3,
      scenario: '逆序输入',
      body: '返回了负数',
      known: true,
    },
  ],
}

async function fixture(status: typeof issues.$inferSelect.status = 'done') {
  const s = await scenario({ body: '分支：docs/design' })
  s.db.update(repos).set({ reviewLevel: 'shadow' }).run()
  const issue = await s.issue(42, status)
  const delivery = s.db
    .insert(runs)
    .values({ issueId: issue.id, worker: 'delivery', branch, startedAt: clock, endedAt: clock })
    .returning()
    .get()
  s.db
    .update(issues)
    .set({ lastRunId: delivery.id, prUrl, prState: 'open' })
    .where(eq(issues.id, issue.id))
    .run()
  const request = (overrides: Partial<typeof reviews.$inferInsert> = {}) =>
    s.db
      .insert(reviews)
      .values({
        repoId: s.repo.id,
        issueId: issue.id,
        deliveryRunId: delivery.id,
        prUrl,
        branch,
        headSha: 'a'.repeat(40),
        partial: false,
        status: 'queued',
        createdAt: clock,
        ...overrides,
      })
      .returning()
      .get()
  const options = { ...s.options, executorSettings: { ...s.executorSettings, concurrency: 1 } }
  const taskReview = async (pid: number | null = 123) => {
    const taskDir = join(s.workspace, 'tasks', 'a-b-42-review')
    await mkdir(join(taskDir, 'out'), { recursive: true })
    const run = s.db
      .insert(runs)
      .values({
        issueId: issue.id,
        kind: 'review',
        worker: 'test',
        taskDir,
        pid,
        startedAt: clock,
      })
      .returning()
      .get()
    const review = request({ status: 'running', runId: run.id })
    return { taskDir, run, review }
  }
  return { ...s, target: issue, delivery, request, options, taskReview }
}

test.each([
  ['独立 PR 基分支', 'upstream', 'review-model', 'xhigh'],
  ['已删除的基分支', 'deleted', null, null],
] as const)(
  '真实 Git：%s上的评审检出交付提交并使用评审模型',
  async (_case, baseName, reviewModel, reviewEffort) => {
    const s = await fixture()
    try {
      const remote = await localRemote(s.workspace)
      const initial = await remote.commit('refs/heads/main', 'initial')
      const fork = await remote.commit('refs/heads/upstream', 'fork', initial)
      const headSha = await remote.commit(`refs/heads/${branch}`, 'delivery', fork)
      await remote.commit('refs/heads/upstream', 'upstream moved', fork)
      await remote.commit('refs/heads/main', 'default moved', initial)
      await remote.commit('refs/heads/docs/design', 'docs', initial)
      const expectedBase = baseName === 'deleted' ? initial : fork
      const review = s.request({ headSha })
      const gh: string[][] = []
      const pi = parsePiSettings({
        model: 'delivery-model',
        effort: 'low',
        reviewModel,
        reviewEffort,
        piModel: 'pi-test',
      })
      let taskDir: string | undefined
      await launchReviews({
        ...s.options,
        pi,
        command: async (args, options) => {
          if (args[0] === 'git') return remote.git(args, options)
          gh.push(args)
          if (args[2] === 'view' && args[3] === prUrl) {
            if (args.at(-1) === 'baseRefName,headRefOid')
              return JSON.stringify({ baseRefName: baseName, headRefOid: headSha })
            return JSON.stringify({
              number: 7,
              url: prUrl,
              title: '交付',
              body: '实现方声明',
              isDraft: false,
            })
          }
          if (args.at(-1) === 'reviews,comments,statusCheckRollup')
            return JSON.stringify({ reviews: [], comments: [], statusCheckRollup: [] })
          if (args.includes('--slurp')) return '[]'
          return s.command(args, options)
        },
        executor: fakeExecutor({
          async start(spec) {
            taskDir = spec.taskDir
            return { pid: 123 }
          },
        }),
      })
      expect(taskDir).toBeDefined()
      const cwd = join(taskDir!, 'repo')
      expect(await remote.git(['git', 'rev-parse', 'HEAD'], { cwd })).toBe(headSha)
      expect(await remote.git(['git', 'branch', '--show-current'], { cwd })).toBe(branch)
      expect(await remote.git(['git', 'config', '--get', 'remote.origin.pushurl'], { cwd })).toBe(
        'no-push://disabled',
      )
      expect(await readFile(join(taskDir!, 'input', 'pr.md'), 'utf8')).toContain('实现方声明')
      expect(await readSpec(taskDir!)).toMatchObject({
        contract: 2,
        kind: 'review',
        repo: { branch, baseRef: expectedBase, docBranch: 'docs/design' },
        model: {
          codex: reviewModel ?? 'delivery-model',
          effort: reviewEffort ?? 'high',
          pi: 'pi-test',
        },
      })
      const run = s.db.select().from(runs).where(eq(runs.kind, 'review')).get()!
      expect(run).toMatchObject({
        baseRef: expectedBase,
        branch: null,
        stackBranch: null,
        pid: 123,
      })
      expect(s.db.select().from(reviews).where(eq(reviews.id, review.id)).get()).toMatchObject({
        status: 'running',
        runId: run.id,
        model: reviewModel ?? 'delivery-model',
        effort: reviewEffort ?? 'high',
      })
      expect(s.db.select().from(issues).get()).toMatchObject({
        status: 'done',
        lastRunId: s.delivery.id,
      })
      expect(gh.some((args) => ['edit', 'comment', 'create'].includes(args[2]!))).toBe(false)
    } finally {
      await s.dispose()
    }
  },
)

test.each([
  ['off', '评审已关闭'],
  ['newer', '已有更新的交付'],
  ['active', 'Issue 正在执行，等待下一次交付'],
  ['updated', 'PR 已有新的提交'],
  ['missing', '提交 aaaaaaa 已不在仓库中'],
  ['unrelated', '无法确定评审范围'],
] as const)('跳过 %s 时保留名额并继续拉起下一项评审', async (caseName, error) => {
  const s = await fixture(caseName === 'active' ? 'queued' : 'done')
  try {
    const skipped = s.request()
    if (caseName === 'off') {
      s.db.update(repos).set({ reviewLevel: 'off' }).run()
    } else if (caseName === 'newer') {
      s.request({ deliveryRunId: s.delivery.id + 100 })
    }
    const nextRepo = s.db
      .insert(repos)
      .values({
        ref: 'github:a/other',
        path: 'a/other',
        host: 'github.com',
        platform: 'github',
        token: 'token',
        reviewLevel: 'shadow',
        createdAt: clock,
        updatedAt: clock,
      })
      .returning()
      .get()
    const nextIssue = await s.issue(43, 'done', nextRepo.id)
    const next = s.request({
      repoId: nextRepo.id,
      issueId: nextIssue.id,
      deliveryRunId: s.delivery.id + 200,
      prUrl: 'https://github.com/a/other/pull/8',
      headSha: 'c'.repeat(40),
    })
    const starts: string[] = []
    await launchReviews({
      ...s.options,
      command: async (args, options) => {
        if (args[0] === 'git') {
          if (args[1] === 'cat-file' && args.at(-1)?.startsWith('a') && caseName === 'missing')
            throw new Error('missing')
          if (args[1] === 'merge-base') {
            if (args.at(-1)?.startsWith('a') && caseName === 'unrelated')
              throw new Error('unrelated')
            return 'c'.repeat(40)
          }
          if (args[1] === 'for-each-ref') return 'refs/heads/main'
        }
        if (args.at(-1) === 'baseRefName,headRefOid')
          return JSON.stringify({
            baseRefName: 'main',
            headRefOid: (args.includes(prUrl)
              ? caseName === 'unrelated'
                ? 'a'
                : 'b'
              : 'c'
            ).repeat(40),
          })
        return s.command(args, options)
      },
      executor: fakeExecutor({
        async start(spec) {
          starts.push(spec.ref)
          return { pid: 123 }
        },
      }),
    })
    expect(s.db.select().from(reviews).where(eq(reviews.id, skipped.id)).get()).toMatchObject({
      status: 'skipped',
      runId: null,
      error,
      endedAt: clock,
    })
    expect(starts).toEqual(['github:a/other#43'])
    expect(s.db.select().from(reviews).where(eq(reviews.id, next.id)).get()?.status).toBe('running')
    expect(s.db.select().from(runs).where(eq(runs.kind, 'review')).all()).toHaveLength(1)
  } finally {
    await s.dispose()
  }
})

test('运行中的 Issue 和评审相互占用同一个名额', async () => {
  const s = await fixture()
  try {
    await s.issue(43, 'running')
    const review = s.request()
    const commands: string[][] = []
    const command: typeof s.command = async (args) => {
      commands.push(args)
      return ''
    }
    await launchReviews({ ...s.options, command })
    expect(s.db.select().from(reviews).where(eq(reviews.id, review.id)).get()?.status).toBe(
      'queued',
    )
    expect(commands).toEqual([])
    s.db.update(issues).set({ status: 'queued' }).where(eq(issues.number, 43)).run()
    s.db
      .insert(runs)
      .values({ issueId: s.target.id, kind: 'review', worker: 'test', startedAt: clock })
      .run()
    await launchQueued({ ...s.options, command })
    expect(s.db.select().from(issues).where(eq(issues.number, 43)).get()?.status).toBe('queued')
    expect(commands).toEqual([])
  } finally {
    await s.dispose()
  }
})

test.each([
  ['成功', null],
  ['缺少产出', '缺少 out/review.json'],
  ['无效产出', 'out/review.json 的结构无效'],
  ['非零退出', '退出码 7'],
  ['无效结果', 'result.json 无效'],
  ['进程丢失', '进程丢失'],
  ['OOM', '内存不足（OOM）'],
  ['超时', '超时'],
] as const)('评审对账：%s', async (mode, expectedError) => {
  const s = await fixture()
  try {
    const { taskDir, run } = await s.taskReview()
    const out = join(taskDir, 'out')
    await writeLlmSecrets(taskDir, {
      baseUrl: 'https://example.test',
      apiKey: 'token',
      api: 'openai-responses',
    })
    await writeFile(join(taskDir, 'task.log'), 'worker log repo-secret\n')
    const finishedAt = new Date(clock.getTime() + 60_000)
    if (mode === '成功') await writeFile(join(out, 'review.json'), JSON.stringify(fixtureOutput))
    if (mode === '无效产出') await writeFile(join(out, 'review.json'), '{"verdict":"invalid"}')
    if (['成功', '缺少产出', '无效产出', '非零退出'].includes(mode))
      await writeResult(taskDir, {
        exitCode: mode === '非零退出' ? 7 : 0,
        signal: null,
        finishedAt: finishedAt.toISOString(),
      })
    else if (mode === '无效结果') await writeFile(join(taskDir, 'result.json'), '{')
    let running = mode === '超时'
    const signals: string[] = []
    const finishes: string[] = []
    const options = {
      ...s.options,
      now: () => new Date(finishedAt.getTime() + 1000),
      executor: fakeExecutor({
        async status() {
          return { running, oom: mode === 'OOM' }
        },
        async signal(_run, signal) {
          signals.push(signal)
        },
        async finish(handle) {
          finishes.push(handle.taskDir)
        },
      }),
    }
    if (running) {
      await reconcileReviews(options)
      expect(s.db.select().from(reviews).get()?.status).toBe('running')
      expect(s.db.select().from(runs).where(eq(runs.id, run.id)).get()?.error).toBe('超时')
      await reconcileReviews(options)
      expect(finishes).toEqual([])
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      running = false
    }
    await reconcileReviews(options)
    const review = s.db.select().from(reviews).get()!
    const saved = s.db.select().from(runs).where(eq(runs.id, run.id)).get()!
    expect(review).toMatchObject({
      status: expectedError ? 'failed' : 'done',
      error: expectedError,
      endedAt: saved.endedAt,
    })
    expect(saved.endedAt).not.toBeNull()
    expect(saved).toMatchObject({ error: expectedError, logTail: 'worker log ***' })
    expect(finishes).toEqual([taskDir])
    expect(await Bun.file(join(taskDir, 'secrets', 'llm.json')).exists()).toBe(false)
    if (mode === '成功') {
      const { acceptance, checks, findings, verdict, summary } = fixtureOutput
      expect(review).toMatchObject({
        verdict,
        summary,
        checks: JSON.stringify(checks),
        acceptance: JSON.stringify(acceptance),
        findings: JSON.stringify(findings),
        endedAt: finishedAt,
      })
    }
    expect(s.db.select().from(issues).get()).toMatchObject({
      status: 'done',
      lastRunId: s.delivery.id,
    })
    expect(s.calls).toEqual([])
  } finally {
    await s.dispose()
  }
})

test('启动恢复重新排队没有进程句柄的评审并清理密钥', async () => {
  const s = await fixture()
  try {
    const { run, taskDir } = await s.taskReview(null)
    await writeLlmSecrets(taskDir, {
      baseUrl: 'https://example.test',
      apiKey: 'token',
      api: 'openai-responses',
    })
    await recoverOrphanReviews(s.db, s.workspace, s.log, clock)
    expect(s.db.select().from(reviews).get()).toMatchObject({
      status: 'queued',
      runId: null,
      endedAt: null,
    })
    expect(s.db.select().from(runs).where(eq(runs.id, run.id)).get()).toMatchObject({
      endedAt: clock,
      error: '拉起中断',
    })
    expect(await Bun.file(join(taskDir, 'secrets', 'llm.json')).exists()).toBe(false)
  } finally {
    await s.dispose()
  }
})

test('评审连续三次拉起失败后结束请求，每次清理密钥并记录脱敏原因', async () => {
  const s = await fixture()
  try {
    const review = s.request()
    const attempts: string[] = []
    const options = {
      ...s.options,
      pi: parsePiSettings({ llmBaseUrl: 'https://example.test', llmApiKey: 'model-secret' }),
      command: (async (args, options) => {
        if (args[1] === 'for-each-ref') return 'refs/heads/main'
        if (args[1] === 'merge-base') return 'b'.repeat(40)
        if (args.at(-1) === 'baseRefName,headRefOid')
          return JSON.stringify({ baseRefName: 'main', headRefOid: review.headSha })
        if (args[2] === 'view' && args[3] === prUrl)
          return JSON.stringify({
            number: 7,
            url: prUrl,
            title: '交付',
            body: '完成',
            isDraft: false,
          })
        if (args.at(-1) === 'reviews,comments,statusCheckRollup')
          return JSON.stringify({ reviews: [], comments: [], statusCheckRollup: [] })
        if (args.includes('--slurp')) return '[]'
        return s.command(args, options)
      }) satisfies typeof s.command,
      executor: fakeExecutor({
        async start({ taskDir }) {
          attempts.push(taskDir)
          expect(await Bun.file(join(taskDir, 'secrets', 'llm.json')).exists()).toBe(true)
          throw new Error('执行器不可用 repo-secret model-secret')
        },
      }),
    }
    for (const status of ['queued', 'queued', 'failed'] as const) {
      await launchReviews(options)
      expect(s.db.select().from(reviews).get()?.status).toBe(status)
    }
    await launchReviews(options)
    expect(new Set(attempts).size).toBe(3)
    for (const taskDir of attempts)
      expect(await Bun.file(join(taskDir, 'secrets', 'llm.json')).exists()).toBe(false)
    const error = '拉起失败：执行器不可用 *** ***'
    const rows = s.db.select().from(runs).where(eq(runs.kind, 'review')).all()
    expect(rows.map((run) => [run.error, run.endedAt])).toEqual(
      Array.from({ length: 3 }, () => [error, clock]),
    )
    expect(s.db.select().from(reviews).get()).toMatchObject({ error, endedAt: clock })
    expect(s.logs.filter((line) => line.includes('评审拉起失败'))).toHaveLength(3)
    expect(s.logs.join('\n')).not.toMatch(/repo-secret|model-secret/)
  } finally {
    await s.dispose()
  }
})
