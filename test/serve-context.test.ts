import { expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { feedback, runs } from '../src/db/schema.ts'
import { writeRunContext } from '../src/serve/context.ts'
import { baseRef, clock, scenario } from './helpers/serve.ts'

async function fixture() {
  const s = await scenario()
  const issue = await s.issue()
  const taskDir = join(s.workspace, 'tasks', 'current')
  const runId = s.db
    .insert(runs)
    .values({ issueId: issue.id, worker: 'worker', taskDir, startedAt: clock, error: '本次运行' })
    .returning()
    .get().id
  const context = {
    db: s.db,
    taskDir,
    repo: s.repo,
    issue,
    runId,
    checkout: { baseRef, branch: 'workling/42-issue', start: 'main' },
    command: s.command,
    secrets: [s.repo.token, 'llm-secret'],
    log: s.log,
  }
  return { ...s, context, read: (name: string) => readFile(join(taskDir, 'input', name), 'utf8') }
}

test('feedback.md 显示本批编号、位置、指令和截断并脱敏；空批次有提示', async () => {
  const s = await fixture()
  try {
    await writeRunContext(s.context)
    expect(await s.read('feedback.md')).toContain('无本轮反馈。')
    const row = s.db
      .insert(feedback)
      .values({
        repoId: s.repo.id,
        issueId: s.context.issue.id,
        runId: s.context.runId,
        source: 'review_comment',
        externalId: '1',
        authorId: '1',
        authorLogin: 'alice',
        trust: 'write',
        isCommand: false,
        body: `repo-secret ${'长'.repeat(8001)}`,
        path: 'src/a.ts',
        line: 12,
        url: 'https://example.com/1',
        status: 'included',
        createdAt: clock,
        updatedAt: clock,
        seenAt: clock,
      })
      .returning()
      .get()
    await writeRunContext({ ...s.context, kind: 'rework' })
    const content = await s.read('feedback.md')
    expect(content).toContain(`F${row.id} · 行内评论 · @alice`)
    expect(content).toContain('类型：rework')
    expect(content).toContain('位置：src/a.ts:12')
    expect(content).toContain('链接：https://example.com/1')
    expect(content).toContain('（已截断）')
    expect(content).not.toContain('repo-secret')
  } finally {
    await s.dispose()
  }
})

test('runs.md 只列此前最近五次运行，包含脱敏并截断的回报与 Pi 说明', async () => {
  const s = await fixture()
  try {
    const dir = join(s.workspace, 'tasks', 'previous')
    await mkdir(join(dir, 'out'), { recursive: true })
    await writeFile(join(dir, 'report.md'), `此前回报 repo-secret ${'长'.repeat(20_001)}`)
    await writeFile(
      join(dir, 'out', 'issue-comment.md'),
      `此前说明 llm-secret ${'长'.repeat(10_001)}`,
    )
    for (let index = 0; index < 6; index++) {
      s.db
        .insert(runs)
        .values({
          issueId: s.context.issue.id,
          worker: 'worker',
          startedAt: new Date(clock.getTime() - (6 - index) * 1000),
          endedAt: clock,
          taskDir: index === 5 ? dir : null,
          reportResult: `历史结果 ${index}`,
          branch: 'workling/42-issue',
          baseRef,
        })
        .run()
    }
    s.db
      .insert(runs)
      .values({
        issueId: s.context.issue.id,
        kind: 'review',
        worker: 'worker',
        startedAt: clock,
        reportResult: '影子评审记录',
      })
      .run()
    const other = await s.issue(43)
    s.db
      .insert(runs)
      .values({ issueId: other.id, worker: 'worker', startedAt: clock, error: '其他 Issue' })
      .run()
    await writeRunContext(s.context)
    const content = await s.read('runs.md')
    expect(content.match(/^## 第 [1-5] 次运行 · /gm)).toHaveLength(5)
    expect(content).toContain('## 第 1 次运行 · 2026-11-14T10:29:55.000Z')
    expect(content).toContain('## 第 5 次运行 · 2026-11-14T10:29:59.000Z')
    expect(content).toContain('### 回报\n\n此前回报 ***')
    expect(content).toContain('### Pi 的说明\n\n此前说明 ***')
    expect(content.match(/（已截断）/g)).toHaveLength(2)
    for (const missing of [
      '历史结果 0',
      '本次运行',
      '其他 Issue',
      '影子评审记录',
      'repo-secret',
      'llm-secret',
    ])
      expect(content).not.toContain(missing)
  } finally {
    await s.dispose()
  }
})

test('接续的 branch.md 列出已有提交、限制改动统计行数并说明起点已前进', async () => {
  const s = await fixture()
  try {
    const ref = 'refs/remotes/origin/docs/design'
    const commands: string[][] = []
    await writeRunContext({
      ...s.context,
      checkout: { ...s.context.checkout, continued: true, start: 'docs/design' },
      command: async (args, options) => {
        if (args[0] !== 'git') return s.command(args, options)
        expect(options?.cwd).toBe(join(s.context.taskDir, 'repo'))
        commands.push(args)
        if (args[1] === 'log') return 'abc123 已有改动'
        if (args[1] === 'merge-base') return baseRef
        if (args[1] === 'diff')
          return Array.from({ length: 201 }, (_, i) => `file-${i + 1}.ts | 2 +-`).join('\n')
        return '2'
      },
    })
    expect(commands).toEqual([
      ['git', 'log', '--oneline', '--no-decorate', '-n', '50', `${ref}..HEAD`],
      ['git', 'merge-base', ref, 'HEAD'],
      ['git', 'diff', '--stat', `${baseRef}..HEAD`],
      ['git', 'rev-list', '--count', `HEAD..${ref}`],
    ])
    const content = await s.read('branch.md')
    for (const line of [
      '是否接续：是',
      'abc123 已有改动',
      'file-200.ts | 2 +-',
      '起点分支在分叉后又前进了 2 个提交，未自动 rebase',
    ])
      expect(content).toContain(line)
    expect(content).not.toContain('file-201.ts')
  } finally {
    await s.dispose()
  }
})

test('pr.md 渲染 review、分页行内评论的位置与检查结论', async () => {
  const s = await fixture()
  try {
    const at = clock.toISOString()
    const commands: string[][] = []
    await writeRunContext({
      ...s.context,
      command: async (args, options) => {
        commands.push(args)
        expect(options?.env?.GH_TOKEN).toBe(s.repo.token)
        if (args[2] === 'list')
          return JSON.stringify([
            {
              number: 9,
              url: 'https://github.com/a/b/pull/9',
              title: '标题',
              body: '正文',
              isDraft: true,
            },
          ])
        if (args[2] === 'view')
          return JSON.stringify({
            reviews: [
              {
                author: { login: 'reviewer' },
                state: 'CHANGES_REQUESTED',
                body: '修正边界',
                submittedAt: at,
              },
            ],
            comments: [{ author: { login: 'teammate' }, body: '普通评论', createdAt: at }],
            statusCheckRollup: [
              { name: 'build', conclusion: 'SUCCESS', __typename: 'CheckRun' },
              { context: 'lint', state: 'PENDING' },
            ],
          })
        const comment = {
          user: { login: 'reviewer' },
          path: 'src/index.ts',
          body: '行内建议',
          created_at: at,
        }
        return JSON.stringify([
          [{ ...comment, line: 42, original_line: 40 }],
          [{ ...comment, line: null, original_line: 5 }],
        ])
      },
    })
    expect(commands).toEqual([
      [
        'gh',
        'pr',
        'list',
        '-R',
        'a/b',
        '--head',
        'workling/42-issue',
        '--state',
        'open',
        '--json',
        'number,url,title,body,isDraft',
      ],
      ['gh', 'pr', 'view', '9', '-R', 'a/b', '--json', 'reviews,comments,statusCheckRollup'],
      ['gh', 'api', 'repos/a/b/pulls/9/comments', '--paginate', '--slurp'],
    ])
    const content = await s.read('pr.md')
    for (const line of [
      '# 标题',
      '是否草稿：是',
      '正文',
      '## Review',
      '修正边界',
      '普通评论',
      'src/index.ts:42',
      'src/index.ts:5',
      '行内建议',
      'build：SUCCESS',
      'lint：PENDING',
    ])
      expect(content).toContain(line)
  } finally {
    await s.dispose()
  }
})

test('gh 抛错时 pr.md 记录脱敏错误，仍写出其他上下文', async () => {
  const s = await fixture()
  try {
    await writeRunContext({
      ...s.context,
      command: async () => {
        throw new Error('gh 失败 repo-secret llm-secret')
      },
    })
    expect(await s.read('pr.md')).toBe('获取失败：gh 失败 *** ***')
    expect(s.logs).toEqual(['a/b #42 pr.md 获取失败：gh 失败 *** ***'])
    expect(await s.read('runs.md')).toBe('无此前运行。')
    expect(await s.read('branch.md')).toContain('本次从起点新建，暂无提交。')
    expect(await s.read('docs.md')).toBe('无文档分支。')
  } finally {
    await s.dispose()
  }
})

test('链条上下文区分堆叠、已合并与普通 Issue', async () => {
  const s = await fixture()
  try {
    await writeRunContext(s.context)
    expect(await Bun.file(join(s.context.taskDir, 'input', 'chain.md')).exists()).toBe(false)
    const chain = { parent: 10, title: '父任务', position: 2, total: 3 }
    await writeRunContext({
      ...s.context,
      chain: { ...chain, kind: 'stack', previous: 1, branch: 'workling/1-first' },
    })
    expect(await s.read('chain.md')).toContain('主 Issue：#10 父任务')
    expect(await s.read('chain.md')).toContain('第 2 / 3 个子 Issue')
    expect(await s.read('chain.md')).toContain('#1，分支 `workling/1-first`')
    await writeRunContext({ ...s.context, chain: { ...chain, kind: 'base' } })
    expect(await s.read('chain.md')).toContain('上一个子任务已合并，本任务从 main 切出')
  } finally {
    await s.dispose()
  }
})
