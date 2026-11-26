import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePiSettings } from '../src/config/pi.ts'
import { writeOutResult } from '../src/contract/out.ts'
import { readResult, writeResult } from '../src/contract/result.ts'
import { readSpec } from '../src/contract/spec.ts'
import { feedback, issues, planChildren, repos, reviews, runs, sessions } from '../src/db/schema.ts'
import { findDirective, planMode } from '../src/issue/branch.ts'
import { canPlan, type SubIssue } from '../src/issue/chain.ts'
import type { Command } from '../src/runtime/types.ts'
import { launchQueued } from '../src/serve/launch.ts'
import { pollOnce } from '../src/serve/poll.ts'
import { reconcile } from '../src/serve/reconcile.ts'
import { queueRework } from '../src/serve/rework.ts'
import { checkIssue } from '../src/serve/triage.ts'
import { createApp } from '../src/web/app.ts'
import { hashToken } from '../src/web/auth.ts'
import { overviewSchema } from '../src/web/overview.ts'
import { issueDetailSchema } from '../src/web/issue-detail.ts'
import * as Value from 'typebox/value'
import { localRemote } from './helpers/git.ts'
import { clock, fakeExecutor, scenario } from './helpers/serve.ts'

test('模式指令只取代码块和 HTML 注释外的第一行', () => {
  const ignored = '<!--\n模式：拆解\n-->\n```md\n模式：拆解\n```\n~~~~\n模式：拆解\n~~~~'
  expect(findDirective(ignored, '模式')).toBeUndefined()
  expect(planMode(ignored)).toBe(false)
  expect(planMode(`${ignored}\n  模式：  拆解  \n模式：实现`)).toBe(true)
  expect(planMode('模式：')).toEqual({ error: 'Issue 正文的「模式：」行只支持「拆解」' })
  expect(findDirective('分支： \t', '分支')).toBe('')
})

test('分诊只要求拆解需求有目标，拒绝分支和无效模式', () => {
  expect(checkIssue('模式：拆解\n\n## 目标\n支持导出')).toEqual({
    missingSections: [],
    invalidDirectives: [],
  })
  expect(checkIssue('## 目标\n<!-- 填写目标 -->\n模式：拆解').missingSections).toEqual(['目标'])
  expect(checkIssue('模式：拆解\n分支：docs/export').invalidDirectives).toContain(
    '拆解需求不支持「分支：」行',
  )
  expect(checkIssue('模式：实现\n## 目标\n支持导出')).toEqual({
    missingSections: ['验收'],
    invalidDirectives: ['Issue 正文的「模式：」行只支持「拆解」'],
  })
})

const sub = (state: SubIssue['state'], state_reason: SubIssue['stateReason']) => ({
  number: 43,
  title: '子任务',
  state,
  state_reason,
  repository_url: 'https://api.github.com/repos/a/b',
})

test('没有子 Issue 或全部关闭为不计划时可拆解', () => {
  const closed: SubIssue = {
    number: 43,
    title: '子任务',
    state: 'closed',
    stateReason: 'not_planned',
    sameRepo: true,
  }
  expect(canPlan([])).toBe(true)
  expect(canPlan([closed, { ...closed, number: 44 }])).toBe(true)
  expect(canPlan([closed, { ...closed, number: 44, state: 'open' }])).toBe(false)
  expect(canPlan([{ ...closed, stateReason: 'completed' }])).toBe(false)
})

const readyParent = {
  number: 42,
  title: '需求',
  url: 'https://github.com/a/b/issues/42',
  labels: [{ name: 'workling:ready' }, { name: 'workling:done' }],
}

test('全部子 Issue 关闭为不计划时，轮询入队需求而不展开', async () => {
  const s = await scenario()
  try {
    const poll = await pollOnce({
      ...s.options,
      labeledRepos: new Set([s.repo.id]),
      command: async (args, opts) => {
        if (args[2] === 'list') return JSON.stringify([readyParent])
        if (args[2]?.endsWith('/sub_issues?per_page=100'))
          return JSON.stringify([sub('closed', 'not_planned')])
        return s.command(args, opts)
      },
    })
    expect(poll).toEqual({ expanded: 0 })
    expect(s.db.select().from(issues).all()).toMatchObject([{ number: 42, status: 'queued' }])
    expect(s.calls.map(({ args }) => args)).toEqual([
      [
        'gh',
        'issue',
        'edit',
        '42',
        '-R',
        'a/b',
        '--remove-label',
        'workling:done',
        '--remove-label',
        'workling:ready',
        '--add-label',
        'workling:queued',
      ],
    ])
  } finally {
    await s.dispose()
  }
})

test.each([false, true])('拉起拆解运行并选择默认或覆盖模型，接续已有分支=%s', async (continued) => {
  const s = await scenario({
    body: '模式：拆解\n## 目标\n支持导出\n模型：issue-model\n强度：xhigh',
  })
  try {
    const parent = await s.issue(42, 'queued')
    const remote = await localRemote(s.workspace)
    let base = await remote.commit('refs/heads/main', 'base')
    const branch = 'workling/42-issue'
    if (continued) {
      base = await remote.commit(`refs/heads/${branch}`, 'existing design', base)
      s.db
        .insert(runs)
        .values({
          issueId: parent.id,
          worker: 'worker',
          kind: 'plan',
          branch,
          startedAt: clock,
          endedAt: clock,
        })
        .run()
    }
    const command: Command = async (args, opts) => {
      if (args[0] === 'git') return remote.git(args, opts)
      if (args[2]?.endsWith('/sub_issues?per_page=100'))
        return JSON.stringify(continued ? [sub('closed', 'not_planned')] : [])
      return s.command(args, opts)
    }
    await launchQueued({
      ...s.options,
      command,
      pi: parsePiSettings({
        model: 'default',
        effort: 'low',
        ...(continued ? { planModel: 'planner', planEffort: 'medium' } : {}),
      }),
      executor: fakeExecutor(),
    })
    const run = s.db.select().from(runs).orderBy(runs.id).all().at(-1)!
    expect(run).toMatchObject({ kind: 'plan', branch, baseRef: base, pid: 123 })
    expect(await readSpec(run.taskDir!)).toMatchObject({
      kind: 'plan',
      repo: { baseRef: base, branch, ...(continued ? { continued: true } : {}) },
      model: continued
        ? { codex: 'planner', effort: 'medium' }
        : { codex: 'default', effort: 'high' },
    })
    expect(await Bun.file(join(run.taskDir!, 'input', 'branch.md')).exists()).toBe(true)
    expect(s.calls.find(({ args }) => args[2] === 'comment')?.options?.input).toContain(
      `### ▶️ 第 ${continued ? 2 : 1} 轮 · 拆解 · 开始`,
    )
  } finally {
    await s.dispose()
  }
})

test.each([
  ['模式：其他', [], 'Issue 正文的「模式：」行只支持「拆解」'],
  ['模式：拆解\n分支：', [], '拆解需求不支持「分支：」行'],
  ['模式：拆解', [sub('open', null)], '已有未关闭或已完成的子 Issue，不再拆解'],
] as const)('拉起拒绝 %s 或不符合条件的子 Issue', async (body, subs, message) => {
  const s = await scenario({ body })
  try {
    await s.issue(42, 'queued')
    await launchQueued({
      ...s.options,
      executor: fakeExecutor(),
      command: async (args, opts) => {
        if (args[2]?.endsWith('/sub_issues?per_page=100')) return JSON.stringify(subs)
        if (args[0] === 'git') throw new Error('不该检出')
        return s.command(args, opts)
      },
    })
    const run = s.db.select().from(runs).get()!
    expect(run.pid).toBeNull()
    expect(await readResult(run.taskDir!)).toMatchObject({
      error: expect.stringContaining(message),
    })
  } finally {
    await s.dispose()
  }
})

test.each(['open', 'not_planned', 'api_error'] as const)(
  '拆解反馈遇到 %s 时按子 Issue 状态处理',
  async (state) => {
    const s = await scenario()
    try {
      const parent = await s.issue(42, 'done')
      const run = s.db
        .insert(runs)
        .values({
          issueId: parent.id,
          kind: 'plan',
          worker: 'worker',
          startedAt: clock,
          endedAt: clock,
        })
        .returning()
        .get()
      s.db.update(issues).set({ lastRunId: run.id }).where(eq(issues.id, parent.id)).run()
      const later = new Date(clock.getTime() + 1000)
      s.db
        .insert(feedback)
        .values({
          repoId: s.repo.id,
          issueId: parent.id,
          source: 'issue_comment',
          externalId: '1',
          authorId: '1',
          authorLogin: 'human',
          trust: 'write',
          isCommand: true,
          body: '/workling 补充约束',
          url: 'https://github.com/a/b/issues/42#issuecomment-1',
          status: 'observed',
          createdAt: later,
          updatedAt: later,
          seenAt: later,
        })
        .run()
      const command: Command = async (args, opts) => {
        if (args[2]?.endsWith('/sub_issues?per_page=100')) {
          if (state === 'api_error') throw new Error('HTTP 503')
          return JSON.stringify([
            state === 'open' ? sub('open', null) : sub('closed', 'not_planned'),
          ])
        }
        return s.command(args, opts)
      }
      await queueRework({ ...s.options, command })
      expect(s.db.select().from(issues).get()?.status).toBe(
        state === 'not_planned' ? 'queued' : 'done',
      )
      expect(s.db.select().from(feedback).get()?.status).toBe(
        state === 'not_planned' ? 'pending' : state === 'open' ? 'ignored' : 'observed',
      )
      const comment = s.calls.find(({ args }) => args[2] === 'comment')
      if (state === 'open')
        expect(comment?.options?.input).toContain('已经拆出子 Issue，不再重新拆解')
      else expect(comment).toBeUndefined()
    } finally {
      await s.dispose()
    }
  },
)

test('对账保存拆解结果并等待人工放行，放行后概览移除提示', async () => {
  const s = await scenario()
  try {
    s.db.update(repos).set({ reviewLevel: 'shadow' }).run()
    const { issue, dir, run } = await s.running({ delivery: true })
    s.db.update(runs).set({ kind: 'plan' }).where(eq(runs.id, run.id)).run()
    await writeResult(dir, { exitCode: 0, signal: null, finishedAt: clock.toISOString() })
    const out = join(dir, 'out')
    await writeOutResult(out, {
      contract: 2,
      outcome: 'planned',
      branch: run.branch!,
      head: run.baseRef,
      commits: 1,
    })
    await writeFile(
      join(out, 'plan.json'),
      JSON.stringify({
        summary: '先实现导出，再处理格式。',
        docs: ['design.md'],
        children: ['实现导出', '支持格式'].map((title) => ({
          title,
          body: '## 目标\n描述\n## 验收\n检查',
        })),
      }),
    )
    await writeFile(join(out, 'issue-comment.md'), '## 检查\n\n请核对格式选择。')
    const command: Command = async (args, opts) => {
      if (args[1] === 'api' && args[2] === '-X') {
        const { title } = JSON.parse(opts!.input!)
        return title === '实现导出'
          ? '{"number":43,"id":10043}'
          : title === '支持格式'
            ? '{"number":44,"id":10044}'
            : '{}'
      }
      if (args[2] === 'list' && args[1] === 'issue') return JSON.stringify([readyParent])
      if (args[2]?.endsWith('/sub_issues?per_page=100'))
        return JSON.stringify([sub('open', null), { ...sub('open', null), number: 44 }])
      return s.command(args, opts)
    }
    await reconcile({ ...s.options, command, executor: fakeExecutor() })
    expect(s.db.select().from(issues).get()).toMatchObject({
      status: 'done',
      prUrl: null,
      prState: null,
    })
    expect(s.db.select().from(runs).get()?.summary).toBe('先实现导出，再处理格式。')
    expect(s.db.select().from(reviews).all()).toEqual([])
    expect(s.calls.some(({ args }) => args[2] === 'edit' && args.includes('workling:done'))).toBe(
      true,
    )
    const comment = s.calls.find(({ args }) => args[2] === 'comment')?.options?.input
    expect(comment).toStartWith(
      '### 🧩 第 1 轮 · 拆解 · 完成\n\n2 个子 Issue · 用时 2 分钟 · 运行 #1\n\n先实现导出，再处理格式。\n\n**检查**\n\n请核对格式选择。\n\n**子 Issue**\n\n',
    )
    expect(comment).toContain('1. #43 实现导出\n2. #44 支持格式')
    expect(comment).toContain('设计文档：<https://github.com/a/b/tree/workling/42-issue>')
    expect(comment).toContain(
      '**下一步**：审阅文档与子 Issue 后，给本 Issue 重新打上 `workling:ready`，子 Issue 会按上面的顺序执行。要调整可以直接编辑子 Issue；要整体重新拆解，请把子 Issue 全部关闭为「不计划」，再评论 `/workling <说明>`。',
    )
    expect(s.calls.some(({ args }) => args[1] === 'pr')).toBe(false)

    const app = createApp(s.db, { workspace: s.workspace })
    const now = new Date()
    s.db
      .insert(sessions)
      .values({
        id: hashToken('plan-test'),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      .run()
    const get = async (path: string) => {
      const response = await app.request(path, {
        headers: { host: 'localhost', cookie: 'workling_session=plan-test' },
      })
      expect(response.status).toBe(200)
      return await response.json()
    }
    const overview = await get('/api/overview')
    expect(Value.Check(overviewSchema, overview)).toBe(true)
    expect(overview.attention).toMatchObject([{ kind: 'plan_pending', number: 42 }])
    s.db.update(planChildren).set({ linkedAt: null }).where(eq(planChildren.position, 2)).run()
    for (const path of [`/api/issues/${issue.id}/detail`, `/api/runs/${run.id}/detail`]) {
      const detail = await get(path)
      expect(Value.Check(issueDetailSchema, detail)).toBe(true)
      expect(detail.runs).toMatchObject([
        {
          kind: 'plan',
          children: [
            { number: 43, linked: true, url: 'https://github.com/a/b/issues/43' },
            { number: 44, linked: false, url: 'https://github.com/a/b/issues/44' },
          ],
        },
      ])
    }
    expect((await get('/api/issue-list')).issues[0].lastRun.kind).toBe('plan')
    s.calls.length = 0
    expect(await pollOnce({ ...s.options, command, labeledRepos: new Set([s.repo.id]) })).toEqual({
      expanded: 1,
    })
    expect(s.calls.map(({ args }) => args[3])).toEqual(['43', '44', '42'])
    expect(s.calls.at(-1)?.args).toEqual([
      'gh',
      'issue',
      'edit',
      '42',
      '-R',
      'a/b',
      '--remove-label',
      'workling:done',
      '--remove-label',
      'workling:ready',
      '--add-label',
      'workling:running',
    ])
    expect((await get('/api/overview')).attention).toEqual([])
  } finally {
    await s.dispose()
  }
})
