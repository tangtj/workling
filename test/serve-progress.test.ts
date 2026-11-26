import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { issues, runs } from '../src/db/schema.ts'
import { AI_NOTICE } from '../src/serve/comment.ts'
import { renderProgress, syncProgress } from '../src/serve/progress.ts'
import { clock, scenario } from './helpers/serve.ts'

type Issue = Parameters<typeof renderProgress>[0]
type Run = Parameters<typeof renderProgress>[1][number]
const issue: Issue = { status: 'done', prState: null, prUrl: null }
const start = new Date('2026-11-26T12:37:00+08:00')
const run: Run = {
  id: 7,
  kind: 'implement',
  startedAt: start,
  endedAt: new Date('2026-11-26T04:37:01Z'),
  outcome: 'completed',
  error: null,
}

test.each([
  ['queued', null, null, '⏳ 排队中'],
  ['running', null, null, '▶️ 第 2 轮进行中'],
  ['done', 'open', 'completed', '👀 等待评审与合并'],
  ['done', 'merged', 'completed', '✅ 已合并'],
  ['done', 'closed', 'completed', 'PR 已关闭'],
  ['done', null, 'planned', '🧩 拆解完成，等待确认'],
  ['done', null, 'answered', '💬 已答复'],
  ['failed', 'open', null, '❌ 未完成，等待处理'],
  ['canceled', 'merged', null, '已取消'],
] as const)(
  '进度标题对应 Issue 状态 %s、PR 状态 %s 和结果 %s',
  (status, prState, outcome, title) => {
    const rounds: Run[] = [
      { ...run, id: 15, outcome, endedAt: status === 'running' ? null : run.endedAt },
      run,
      { ...run, id: 99, kind: 'review' },
    ]
    expect(renderProgress({ ...issue, status, prState }, rounds).split('\n')[0]).toBe(
      `### 进度 · ${title}`,
    )
  },
)

test.each([
  [null, '已取消', 'completed', '▶️ 进行中', ''],
  [run.endedAt, '已取消', null, '已取消', '1 分钟'],
  [run.endedAt, '失败 | 私有原因', 'completed', '❌ 未完成', '1 分钟'],
  [run.endedAt, null, 'completed', '✅ 完成', '1 分钟'],
  [run.endedAt, null, 'partial', '🟡 部分完成', '1 分钟'],
  [run.endedAt, null, 'answered', '💬 答复', '1 分钟'],
  [run.endedAt, null, 'planned', '🧩 完成', '1 分钟'],
  [run.endedAt, null, null, '已结束', '1 分钟'],
] as const)(
  '进度表格的结果为 %s / %s / %s 时显示 %s',
  (endedAt, error, outcome, result, duration) => {
    const body = renderProgress(issue, [{ ...run, endedAt, error, outcome }])
    expect(body.split('\n')).toContain(`| 1 | 实现 | ${result} | ${duration} | 11-26 04:37 UTC |`)
    expect(body).not.toContain('私有原因')
  },
)

test.each([
  ['https://github.com/a/b/pull/128', '[PR #128](https://github.com/a/b/pull/128)'],
  ['https://example.com/pr/128', 'https://example.com/pr/128'],
  [null, undefined],
] as const)('进度正文按 PR 链接 %s 决定是否显示 PR 行', (prUrl, link) => {
  expect(renderProgress({ ...issue, prUrl }, [run]).split('\n\n')).toEqual([
    '### 进度 · 💬 已答复',
    ...(link ? [link] : []),
    [
      '| 轮次 | 类型 | 结果 | 用时 | 开始 |',
      '| ---- | ---- | ---- | ---- | ---- |',
      '| 1 | 实现 | ✅ 完成 | 1 分钟 | 11-26 04:37 UTC |',
    ].join('\n'),
    '这条评论由 workling 随进度更新；每一轮的详情见下方对应的评论。',
  ])
})

test('进度按 ID 排序并保留最近 20 轮的原轮次，排除评审', () => {
  const rounds: Run[] = Array.from({ length: 22 }, (_, i) => ({ ...run, id: 2 * (i + 1) }))
  rounds[2] = { ...rounds[2]!, kind: 'plan' }
  rounds[21] = { ...rounds[21]!, kind: 'rework', endedAt: new Date('2026-11-26T06:37:01Z') }
  const body = renderProgress({ ...issue, status: 'running' }, [
    ...rounds.reverse(),
    { ...run, id: 3, kind: 'review' },
    { ...run, id: 45, kind: 'review' },
  ])
  expect(body).toStartWith('### 进度 · ▶️ 第 22 轮进行中\n\n（更早的 2 轮已省略）\n\n')
  const rows = body.split('\n').filter((line) => /^\| \d+ /.test(line))
  expect(rows).toHaveLength(20)
  expect(rows[0]).toStartWith('| 3 | 拆解 |')
  expect(rows.at(-1)).toBe('| 22 | 返工 | ✅ 完成 | 2 小时 1 分钟 | 11-26 04:37 UTC |')
  expect(body).not.toContain('| 评审 |')
})

test('同步读取最新状态，创建带标记的评论并保存 ID，随后编辑同一条', async () => {
  const s = await scenario()
  try {
    const stale = await s.issue(42, 'queued')
    s.db.update(issues).set({ status: 'running' }).where(eq(issues.id, stale.id)).run()
    s.db.insert(runs).values({ issueId: stale.id, startedAt: clock, worker: 'agent' }).run()
    const options = { ...s.options, repo: s.repo, issue: stale }
    await syncProgress(options)
    expect(s.db.select().from(issues).get()).toMatchObject({
      progressCommentId: 1042,
      updatedAt: clock,
    })
    const post = s.calls[0]!
    expect(post.args).toEqual([
      'gh',
      'api',
      '--method',
      'POST',
      'repos/a/b/issues/42/comments',
      '--input',
      '-',
    ])
    expect(JSON.parse(post.options!.input!).body).toBe(
      `### 进度 · ▶️ 第 1 轮进行中\n\n| 轮次 | 类型 | 结果 | 用时 | 开始 |\n| ---- | ---- | ---- | ---- | ---- |\n| 1 | 实现 | ▶️ 进行中 |  | 11-14 10:30 UTC |\n\n这条评论由 workling 随进度更新；每一轮的详情见下方对应的评论。\n\n\n${AI_NOTICE}\n\n<!-- workling -->`,
    )
    expect(post.options?.env).toMatchObject({ GH_HOST: 'github.com', GH_TOKEN: 'repo-secret' })

    await syncProgress(options)
    expect(s.calls).toHaveLength(2)
    expect(s.calls[1]?.args).toEqual([
      'gh',
      'api',
      '--method',
      'PATCH',
      'repos/a/b/issues/comments/1042',
      '--input',
      '-',
    ])
    expect(s.calls[1]?.options?.input).toBe(post.options?.input)
    expect(s.db.select().from(issues).get()?.progressCommentId).toBe(1042)
    expect(s.logs).toEqual([])
  } finally {
    await s.dispose()
  }
})

test.each([true, false])(
  '更新返回 HTTP 404 时清空旧 ID，仅重新创建一次（成功=%s）',
  async (success) => {
    const s = await scenario()
    try {
      const row = await s.issue()
      s.db.update(issues).set({ progressCommentId: 55 }).where(eq(issues.id, row.id)).run()
      const calls: string[][] = []
      await syncProgress({
        ...s.options,
        repo: s.repo,
        issue: row,
        command: async (args, options) => {
          calls.push(args)
          if (args[3] === 'PATCH') throw new Error('gh: Not Found (HTTP 404)')
          expect(s.db.select().from(issues).get()?.progressCommentId).toBeNull()
          if (!success) throw new Error('HTTP 404')
          return s.command(args, options)
        },
      })
      expect(calls.map((args) => args.slice(3, 5))).toEqual([
        ['PATCH', 'repos/a/b/issues/comments/55'],
        ['POST', 'repos/a/b/issues/42/comments'],
      ])
      expect(s.db.select().from(issues).get()).toMatchObject({
        status: 'running',
        progressCommentId: success ? 1042 : null,
      })
      expect(s.logs).toEqual(success ? [] : ['github:a/b #42 更新进度评论失败：HTTP 404'])
    } finally {
      await s.dispose()
    }
  },
)

test.each([
  ['创建命令失败', null, undefined],
  ['创建响应不是 JSON', null, 'not json'],
  ['创建响应缺少 ID', null, '{}'],
  ['创建响应 ID 不是整数', null, '{"id":1.5}'],
  ['更新命令失败', 55, undefined],
] as const)('%s 时只记日志，保留状态和评论 ID', async (_name, id, response) => {
  const s = await scenario()
  try {
    const row = await s.issue(42, 'failed')
    s.db.update(issues).set({ progressCommentId: id }).where(eq(issues.id, row.id)).run()
    const calls: string[] = []
    await syncProgress({
      ...s.options,
      repo: s.repo,
      issue: row,
      command: async (args) => {
        calls.push(args[3]!)
        if (response === undefined) throw new Error('HTTP 403')
        return response
      },
    })
    expect(calls).toEqual([id === null ? 'POST' : 'PATCH'])
    expect(s.db.select().from(issues).get()).toMatchObject({
      status: 'failed',
      progressCommentId: id,
      updatedAt: clock,
    })
    expect(s.logs).toHaveLength(1)
    expect(s.logs[0]).toStartWith('github:a/b #42 更新进度评论失败：')
  } finally {
    await s.dispose()
  }
})

test('非 GitHub 仓库不同步进度评论', async () => {
  const s = await scenario()
  try {
    const row = await s.issue()
    await syncProgress({ ...s.options, repo: { ...s.repo, platform: 'gitlab' }, issue: row })
    expect(s.calls).toEqual([])
    expect(s.logs).toEqual([])
    expect(s.db.select().from(issues).get()?.progressCommentId).toBeNull()
  } finally {
    await s.dispose()
  }
})
