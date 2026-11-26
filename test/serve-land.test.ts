import { AI_NOTICE } from '../src/serve/comment.ts'
import { eq } from 'drizzle-orm'
import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maxCommentLength, writeOutResult, type Plan } from '../src/contract/out.ts'
import { openDatabase } from '../src/db/index.ts'
import { issues, planChildren, repos, runs } from '../src/db/schema.ts'
import type { Command, RunOptions } from '../src/runtime/types.ts'
import { landRun, publishIssueResult } from '../src/serve/land.ts'
import { localRemote } from './helpers/git.ts'

const issue = { number: 42, title: 'Ship this' }
const repo = { host: 'github.com', path: 'a/b', token: 'configured-test-secret' }
const prUrl = 'https://github.com/a/b/pull/3'
const landed = (head: string, partial = false) =>
  ({ status: 'done', prUrl, prState: 'open', commits: 1, created: true, head, partial }) as const
const commentRun = {
  id: 1,
  kind: 'implement',
  round: 1,
  startedAt: new Date('2026-11-14T10:00:00Z'),
  endedAt: new Date('2026-11-14T10:24:00Z'),
  executor: 'codex',
} as const
const updated = (head: string) => ({ ...landed(head), created: false })
const branch = 'workling/42-task'
const dirs: string[] = []
const dbCleanups: (() => void)[] = []
afterEach(async () => {
  for (const close of dbCleanups.splice(0)) close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function scenario(taskBranch = branch, draft?: boolean) {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-land-'))
  dirs.push(workspace)
  const { db, close } = await openDatabase(workspace)
  dbCleanups.push(close)
  const remote = await localRemote(workspace)
  const base = await remote.commit('refs/heads/main', 'base')
  const mirror = join(workspace, 'mirror.git')
  await remote.git(['git', 'clone', '--bare', remote.path, mirror])
  const taskDir = join(workspace, 'task')
  const cwd = join(taskDir, 'repo')
  const out = join(taskDir, 'out')
  await mkdir(out, { recursive: true })
  await remote.git(['git', 'clone', mirror, cwd])
  const git = (...args: string[]) => remote.git(['git', ...args], { cwd })
  await git('switch', '-c', taskBranch)
  const ref = `refs/heads/${taskBranch}`
  const bundle = join(out, 'commits.bundle')
  const landing = join(workspace, 'landing/1.git')
  const calls: { args: string[]; options?: RunOptions }[] = []
  const logs: string[] = []
  let isDraft = draft
  const command: Command = async (args, options) => {
    calls.push({ args, options })
    if (args[0] === 'git') {
      expect(options?.cwd === landing || options?.cwd?.startsWith(join(landing, 'rebase-'))).toBe(
        true,
      )
      if (
        args.includes('ls-remote') ||
        args.includes('push') ||
        args.includes('credential.helper=')
      ) {
        expect(args.slice(1, 5)).toEqual([
          '-c',
          'credential.helper=',
          '-c',
          'credential.helper=!gh auth git-credential',
        ])
        expect(options?.env?.GH_TOKEN).toBe(repo.token)
      }
      return remote.git(args, options)
    }
    if (args[1] === 'api') return 'main'
    if (args[2] === 'list')
      return JSON.stringify(isDraft === undefined ? [] : [{ url: prUrl, state: 'OPEN', isDraft }])
    if (args[2] === 'create') {
      isDraft = args.includes('--draft')
      return prUrl
    }
    return ''
  }
  const options = {
    db,
    workspace,
    repo,
    issue,
    mirror,
    command,
    remoteUrl: remote.path,
    run: { id: 1, kind: 'implement' as const, taskDir, branch: taskBranch, baseRef: base },
    llmApiKey: 'configured-model-secret',
    log: (line: string) => logs.push(line),
  }
  async function commit(content = 'change') {
    await writeFile(join(cwd, 'content.txt'), content)
    await git('add', 'content.txt')
    await git('commit', '-m', 'Update content')
  }
  async function deliver({
    outcome = 'completed',
    extraRef,
    prerequisite = base,
  }: {
    outcome?: 'completed' | 'incomplete' | 'partial'
    extraRef?: string
    prerequisite?: string | null
  } = {}) {
    const tip = await git('rev-parse', 'HEAD')
    const commits = Number(
      await git('rev-list', '--count', prerequisite ? `${prerequisite}..${ref}` : ref),
    )
    await git(
      'bundle',
      'create',
      bundle,
      prerequisite ? `${prerequisite}..${ref}` : ref,
      ...(extraRef ? [extraRef] : []),
    )
    await writeOutResult(out, { contract: 2, outcome, branch: taskBranch, head: tip, commits })
    await writeFile(join(out, 'pr-body.md'), 'Thanks @someone and @org/team.')
    await writeFile(join(out, 'pr-comment.md'), 'Checked by @reviewer.')
    return tip
  }
  return {
    options,
    remote,
    base,
    cwd,
    out,
    git,
    ref,
    bundle,
    landing,
    calls,
    logs,
    commit,
    deliver,
  }
}

test('落地推送并创建 PR，处理正文和评论，重试复用分支与 PR，任务 hook 不执行', async () => {
  const s = await scenario()
  await s.commit()
  const tip = await s.deliver()
  const marker = join(s.cwd, 'hook-ran')
  for (const name of ['post-checkout', 'pre-push']) {
    const path = join(s.cwd, '.git/hooks', name)
    await writeFile(path, `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(path, 0o700)
  }
  const result = await landRun(s.options)
  expect(result).toEqual(landed(tip))
  await writeFile(
    join(s.out, 'issue-comment.md'),
    '交付结果：完成。\n## 检查\n\n@someone: checks passed. configured-test-secret configured-model-secret',
  )
  await publishIssueResult({
    ...s.options,
    taskDir: s.options.run.taskDir,
    landed: landed(tip),
    run: commentRun,
  })
  expect(await s.remote.write(['rev-parse', s.ref])).toBe(tip)
  expect(await landRun(s.options)).toEqual(updated(tip))
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(await Bun.file(join(s.landing, 'HEAD')).exists()).toBe(false)
  expect(s.calls.filter(({ args }) => args.includes('push'))).toHaveLength(1)
  const creates = s.calls.filter(({ args }) => args[2] === 'create')
  expect(creates).toHaveLength(1)
  expect(creates[0]?.args).toEqual([
    'gh',
    'pr',
    'create',
    '-R',
    'a/b',
    '--head',
    branch,
    '--base',
    'main',
    '--title',
    issue.title,
    '--body-file',
    '-',
  ])
  expect(creates[0]?.options?.input).toBe(
    `Closes #42\n\nThanks \`@someone\` and \`@org/team\`.\n\n\n${AI_NOTICE}`,
  )
  expect(
    s.calls
      .filter(({ args }) => args[2] === 'comment')
      .map(({ args, options }) => [args[1], options?.input]),
  ).toEqual([
    ['pr', `workling：Checked by \`@reviewer\`.\n\n\n${AI_NOTICE}\n\n<!-- workling -->`],
    [
      'issue',
      `### ✅ 第 1 轮 · 实现 · 完成\n\n[PR #3](${prUrl}) · 新建 · 1 个提交 · 用时 24 分钟 · codex 实现 · 运行 #1\n\n**检查**\n\n<code>&#64;someone</code>: checks passed. *** ***\n\n**下一步**：评审并合并 PR。需要修改时在 PR 或本 Issue 评论 \`/workling <说明>\`。\n\n\n${AI_NOTICE}\n\n<!-- workling -->`,
    ],
  ])
})

test.each(['partial', 'incomplete'] as const)(
  '结果为 %s 但有提交时推送并创建部分完成的 draft PR',
  async (outcome) => {
    const s = await scenario()
    await s.commit()
    const tip = await s.deliver({ outcome })
    await writeFile(join(s.out, 'pr-body.md'), 'Closes #42 done')

    expect(await landRun(s.options)).toEqual(landed(tip, true))
    expect(await s.remote.write(['rev-parse', s.ref])).toBe(tip)
    const create = s.calls.find(({ args }) => args[2] === 'create')
    expect(create?.args).toContain('--draft')
    expect(create?.args[create.args.indexOf('--title') + 1]).toBe('[部分完成] Ship this')
    expect(create?.options?.input).not.toContain('Closes #42')
    expect(create?.options?.input).toContain('Refs #42')
  },
)

test.each([false, true])(
  '远端在本次基点时快进并更新已有 draft PR，重试不重复更新；PR 调用失败=%s',
  async (failPrUpdates) => {
    const s = await scenario(branch, true)
    await s.remote.write(['update-ref', s.ref, s.base])
    await s.commit()
    const tip = await s.deliver()
    const actions: { args: string[]; options?: RunOptions }[] = []
    const options = {
      ...s.options,
      command: (async (args, options) => {
        if (args[1] === 'pr' && ['edit', 'ready', 'comment'].includes(args[2]!)) {
          actions.push({ args, options })
          if (failPrUpdates) throw new Error('API unavailable')
        }
        return s.options.command(args, options)
      }) satisfies Command,
    }
    expect(await landRun(options)).toEqual(updated(tip))
    expect(await s.remote.write(['rev-parse', s.ref])).toBe(tip)
    expect(await landRun(options)).toEqual(updated(tip))
    const pushes = s.calls.filter(({ args }) => args.includes('push'))
    expect(pushes.map(({ args }) => args.slice(5))).toEqual([
      ['push', '--', s.remote.path, `${tip}:${s.ref}`],
    ])
    expect(actions.map(({ args }) => args)).toEqual([
      ['gh', 'pr', 'edit', prUrl, '--title', issue.title, '--body-file', '-'],
      ['gh', 'pr', 'ready', prUrl],
      ['gh', 'pr', 'comment', prUrl, '--body-file', '-'],
    ])
    expect(actions[0]?.options?.input).toBe(
      `Closes #42\n\nThanks \`@someone\` and \`@org/team\`.\n\n\n${AI_NOTICE}`,
    )
    expect(actions[2]?.options?.input).toBe(
      `workling：Checked by \`@reviewer\`.\n\n\n${AI_NOTICE}\n\n<!-- workling -->`,
    )
    expect(s.calls.some(({ args }) => args[2] === 'create')).toBe(false)
    expect(s.logs).toEqual(
      failPrUpdates
        ? ['a/b #42 更新 PR失败', 'a/b #42 将 PR 标记为可审查失败', 'a/b #42 发送 PR 评论失败']
        : [],
    )
  },
)

test('正文以 Refs 开头时按部分完成处理且不前置 Closes', async () => {
  const s = await scenario()
  await s.commit()
  const tip = await s.deliver()
  await writeFile(join(s.out, 'pr-body.md'), 'Refs #42\n> 部分完成：后续处理')

  expect(await landRun(s.options)).toEqual(landed(tip, true))
  const create = s.calls.find(({ args }) => args[2] === 'create')
  expect(create?.args[create.args.indexOf('--title') + 1]).toBe('[部分完成] Ship this')
  expect(create?.options?.input).toBe(`Refs #42\n> 部分完成：后续处理\n\n\n${AI_NOTICE}`)
})

test.each([
  ['incomplete 且没有提交', '没有可交付的提交（outcome: incomplete）'],
  ['缺 bundle', '缺少 out/commits.bundle'],
  ['bundle 过大', 'out/commits.bundle 超出大小限制'],
  ['正文过长', 'out/pr-body.md 超出大小限制'],
  ['bundle 是符号链接', 'commits.bundle'],
  ['多个引用', '恰好包含一个'],
  ['分支超出命名空间', '任务分支不在 Issue 命名空间内'],
  ['引用与记录不符', '与记录一致'],
  ['非基点后代', '不以记录的基点为祖先'],
  ['先改后删 workflow', '.github/workflows/check.yml'],
  ['新增仓库 token', 'Configured secret（content.txt）'],
  ['新增 LLM Key', 'Configured secret（content.txt）'],
  ['远端分支既非本次基点也非本次末端', '远端分支已更新，与本次基点不一致'],
])('%s：落地拒绝且不改远端', async (kind, error) => {
  const s = await scenario(kind === '分支超出命名空间' ? 'workling/420-task' : branch)
  if (kind === '非基点后代') await s.git('switch', '--orphan', 'unrelated')
  await s.commit(
    kind === '新增仓库 token'
      ? repo.token
      : kind === '新增 LLM Key'
        ? s.options.llmApiKey
        : undefined,
  )
  if (kind === '非基点后代') await s.git('branch', '-f', branch, 'HEAD')
  if (kind === '先改后删 workflow') {
    const path = '.github/workflows/check.yml'
    await mkdir(join(s.cwd, '.github/workflows'), { recursive: true })
    await writeFile(join(s.cwd, path), 'name: check\n')
    await s.git('add', path)
    await s.git('commit', '-m', 'Add workflow')
    await s.git('rm', path)
    await s.git('commit', '-m', 'Remove workflow')
  }
  if (kind === '多个引用') await s.git('branch', 'extra')
  if (kind === '远端分支既非本次基点也非本次末端') await s.remote.commit(s.ref, 'other', s.base)
  await s.deliver({
    extraRef: kind === '多个引用' ? 'refs/heads/extra' : undefined,
    prerequisite: kind === '非基点后代' ? null : undefined,
  })
  if (kind === 'incomplete 且没有提交')
    await writeOutResult(s.out, {
      contract: 2,
      outcome: 'incomplete',
      branch,
      head: null,
      commits: 0,
    })
  if (kind === '缺 bundle' || kind === 'bundle 是符号链接') await rm(s.bundle)
  if (kind === 'bundle 是符号链接') await symlink(s.remote.path, s.bundle)
  if (kind === 'bundle 过大') await truncate(s.bundle, 100_000_001)
  if (kind === '正文过长') await writeFile(join(s.out, 'pr-body.md'), '字'.repeat(60_001))
  if (kind === '引用与记录不符') s.options.run.branch = 'workling/42-different'
  const refs = () => s.remote.write(['show-ref'])
  const before = await refs()
  await mkdir(s.landing, { recursive: true })
  await writeFile(join(s.landing, 'stale'), '')
  const result = await landRun(s.options)
  expect(result).toEqual({ status: 'failed', error: expect.stringContaining(error) })
  expect(JSON.stringify(result)).not.toContain(repo.token)
  expect(JSON.stringify(result)).not.toContain(s.options.llmApiKey)
  expect(await refs()).toBe(before)
  expect(await Bun.file(join(s.landing, 'HEAD')).exists()).toBe(false)
  expect(await Bun.file(join(s.landing, 'stale')).exists()).toBe(false)
})

test('PR 查询抛错后清理落地仓库，下轮使用已推送的分支', async () => {
  const s = await scenario()
  await s.commit()
  const tip = await s.deliver()
  await writeFile(join(s.out, 'pr-body.md'), 'fIxEs #42 by @someone')
  await expect(
    landRun({
      ...s.options,
      command: (args, options) => {
        if (args[0] === 'gh' && args[2] === 'list') throw new Error('API unavailable')
        return s.options.command(args, options)
      },
    }),
  ).rejects.toThrow('API unavailable')
  expect(await s.remote.write(['rev-parse', s.ref])).toBe(tip)
  expect(await Bun.file(join(s.landing, 'HEAD')).exists()).toBe(false)
  expect(await landRun(s.options)).toEqual(landed(tip))
  expect(s.calls.filter(({ args }) => args.includes('push'))).toHaveLength(1)
  expect(s.calls.find(({ args }) => args[2] === 'create')?.options?.input).toBe(
    `fIxEs #42 by \`@someone\`\n\n\n${AI_NOTICE}`,
  )
})

test('有原文反引号时转义提及；两条评论失败只记录，不影响落地也不重发', async () => {
  const s = await scenario()
  await s.commit()
  const tip = await s.deliver()
  await writeFile(join(s.out, 'pr-body.md'), '`example @inside` thanks @someone')
  let attempts = 0
  const options = {
    ...s.options,
    command: ((args, opts) => {
      if (args[0] === 'gh' && args[2] === 'comment') {
        attempts++
        return Promise.reject(new Error('评论失败'))
      }
      return s.options.command(args, opts)
    }) satisfies Command,
  }
  expect(await landRun(options)).toEqual(landed(tip))
  await publishIssueResult({
    ...options,
    taskDir: options.run.taskDir,
    landed: landed(tip),
    run: commentRun,
  })
  expect(s.calls.find(({ args }) => args[2] === 'create')?.options?.input).toBe(
    `Closes #42\n\n\`example <code>&#64;inside</code>\` thanks <code>&#64;someone</code>\n\n\n${AI_NOTICE}`,
  )
  expect(await landRun(options)).toEqual(updated(tip))
  expect(s.logs).toEqual(['a/b #42 发送 PR 评论失败', 'a/b #42 发送 Issue 评论失败'])
  expect(attempts).toBe(2)
})

test('堆叠 PR 的标识位于堆叠说明之后', async () => {
  const s = await scenario()
  await s.commit()
  await s.deliver()
  await s.remote.write(['update-ref', 'refs/heads/workling/12-upstream', s.base])
  await landRun({ ...s.options, run: { ...s.options.run, stackBranch: 'workling/12-upstream' } })
  const create = s.calls.find(({ args }) => args[2] === 'create')
  expect(create?.args[create.args.indexOf('--base') + 1]).toBe('workling/12-upstream')
  expect(s.calls.some(({ args }) => args.includes('rebase'))).toBe(false)
  const body = s.calls.find(({ args }) => args[2] === 'create')?.options?.input
  expect(body).toEndWith(
    `堆叠于 #12 的分支 \`workling/12-upstream\`，请先审阅并合并上游 PR。\n\n\n${AI_NOTICE}`,
  )
})

test('更新 PR 时正文已有标识也只保留一个', async () => {
  const s = await scenario(branch, false)
  await s.remote.write(['update-ref', s.ref, s.base])
  await s.commit()
  await s.deliver()
  await writeFile(join(s.out, 'pr-body.md'), `说明\n\n\n${AI_NOTICE}\n`)
  await landRun(s.options)
  const body = s.calls.find(({ args }) => args[1] === 'pr' && args[2] === 'edit')?.options?.input
  expect(body).toBe(`Closes #42\n\n说明\n\n\n${AI_NOTICE}`)
})

async function mergedUpstreamScenario(conflict = false) {
  const s = await scenario()
  await s.commit()
  const oldTip = await s.deliver()
  let newBase: string
  if (conflict) newBase = await s.remote.commit('refs/heads/main', 'conflicting change', s.base)
  else {
    await s.git('switch', 'main')
    await writeFile(join(s.cwd, 'upstream.txt'), 'merged upstream')
    await s.git('add', 'upstream.txt')
    await s.git('commit', '-m', 'Merge upstream')
    newBase = await s.git('rev-parse', 'HEAD')
    await s.git('push', s.remote.path, 'main')
  }
  const options = {
    ...s.options,
    run: { ...s.options.run, stackBranch: 'workling/12-upstream' },
    command: (async (args, opts) => {
      if (args[0] === 'gh' && args.includes('merged')) {
        s.calls.push({ args, options: opts })
        return '[{"number":12}]'
      }
      return s.options.command(args, opts)
    }) satisfies Command,
  }
  return { ...s, options, newBase, oldTip }
}

test.each(['不存在', '基点', '旧 tip'])(
  '上游已合并且分支删除，远端分支为%s时带 lease 变基交付到默认分支',
  async (remoteState) => {
    const s = await mergedUpstreamScenario()
    const previous = remoteState === '旧 tip' ? s.oldTip : remoteState === '基点' ? s.base : ''
    if (remoteState === '旧 tip') await s.git('push', s.remote.path, `${s.oldTip}:${s.ref}`)
    else if (previous) await s.remote.write(['update-ref', s.ref, previous])
    const result = await landRun(s.options)
    const newTip = await s.remote.write(['rev-parse', s.ref])
    expect(result).toEqual({ ...landed(newTip), restacked: { baseRef: s.newBase } })
    expect(newTip).not.toBe(s.oldTip)
    expect(await s.remote.write(['rev-parse', `${s.ref}^`])).toBe(s.newBase)
    expect(await s.remote.write(['show', `${s.ref}:upstream.txt`])).toBe('merged upstream')
    const push = s.calls.find(({ args }) => args.includes('push'))
    expect(push?.args).toContain(`--force-with-lease=${s.ref}:${previous}`)
    const create = s.calls.find(({ args }) => args[2] === 'create')
    expect(create?.args[create.args.indexOf('--base') + 1]).toBe('main')
    expect(create?.options?.input).toContain('上游 #12 已在本任务运行期间合并，已自动变基到 main。')
    expect(create?.options?.input).not.toContain('堆叠于')
    expect(s.calls.find(({ args }) => args.includes('merged'))?.args).toEqual([
      'gh',
      'pr',
      'list',
      '-R',
      'a/b',
      '--head',
      'workling/12-upstream',
      '--state',
      'merged',
      '--json',
      'number',
      '--limit',
      '1',
    ])
    expect(await Bun.file(join(s.landing, 'HEAD')).exists()).toBe(false)
  },
)

test('变基结果推送成功但建 PR 失败，下轮识别新 tip 并跳过推送', async () => {
  const s = await mergedUpstreamScenario()
  await expect(
    landRun({
      ...s.options,
      command: (args, opts) => {
        if (args[0] === 'gh' && args[2] === 'create') throw new Error('API unavailable')
        return s.options.command(args, opts)
      },
    }),
  ).rejects.toThrow('API unavailable')
  const firstTip = await s.remote.write(['rev-parse', s.ref])
  // 即使下一轮的提交者时钟变化，重试也必须生成相同的 tip。
  expect(
    await landRun({
      ...s.options,
      command: (args, opts) =>
        s.options.command(
          args,
          args.includes('rebase')
            ? {
                ...opts,
                env: { ...opts?.env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' },
              }
            : opts,
        ),
    }),
  ).toEqual({ ...landed(firstTip), restacked: { baseRef: s.newBase } })
  expect(await s.remote.write(['rev-parse', s.ref])).toBe(firstTip)
  expect(s.calls.filter(({ args }) => args.includes('push'))).toHaveLength(1)
})

test('上游已合并后的变基发生冲突，返回冲突文件并 abort，不推送', async () => {
  const s = await mergedUpstreamScenario(true)
  expect(await landRun(s.options)).toEqual({
    status: 'failed',
    error: '上游 #12 已合并，变基到 main 冲突：content.txt',
  })
  expect(s.calls.some(({ args }) => args.includes('--abort'))).toBe(true)
  expect(s.calls.some(({ args }) => args.includes('push'))).toBe(false)
  expect(await Bun.file(join(s.landing, 'HEAD')).exists()).toBe(false)
})

test.each(['未合并', '格式无效'])('上游分支删除且 PR %s，拒绝交付并保留远端', async (kind) => {
  const s = await mergedUpstreamScenario()
  const options = {
    ...s.options,
    command: (args: string[], opts?: RunOptions) => {
      if (args[0] === 'gh' && args.includes('merged'))
        return Promise.resolve(kind === '未合并' ? '[]' : '[{"number":"12"}]')
      return s.options.command(args, opts)
    },
  }
  if (kind === '未合并')
    expect(await landRun(options)).toEqual({
      status: 'failed',
      error: '上游分支 workling/12-upstream 已删除且未合并，无法堆叠交付',
    })
  else await expect(landRun(options)).rejects.toThrow('已合并 PR 列表格式无效')
  expect(s.calls.some(({ args }) => args.includes('push'))).toBe(false)
})

test('变基交付时远端已被他人更新，拒绝覆盖', async () => {
  const s = await mergedUpstreamScenario()
  const other = await s.remote.commit(s.ref, 'other', s.base)
  expect(await landRun(s.options)).toEqual({
    status: 'failed',
    error: '远端分支已更新，与本次基点不一致',
  })
  expect(await s.remote.write(['rev-parse', s.ref])).toBe(other)
  expect(s.calls.some(({ args }) => args.includes('push'))).toBe(false)
})

const planBody = '## 目标\n完成一部分\n\n## 验收\n- [ ] 检查结果'
const planExample: Plan = {
  summary: '分三步完成',
  docs: [],
  children: ['甲', '乙', '丙'].map((title) => ({ title, body: planBody })),
}

async function planScenario(docPath?: string, contents = '# Design') {
  const s = await scenario()
  const { db } = s.options
  const now = new Date()
  const project = db
    .insert(repos)
    .values({
      ...repo,
      ref: 'github:a/b',
      platform: 'github',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  const parent = db
    .insert(issues)
    .values({
      repoId: project.id,
      number: issue.number,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  const record = db
    .insert(runs)
    .values({
      ...s.options.run,
      issueId: parent.id,
      kind: 'plan',
      worker: 'worker',
      startedAt: now,
    })
    .returning()
    .get()
  const plan: Plan = { ...structuredClone(planExample), docs: docPath ? [docPath] : [] }
  if (docPath) {
    await writeFile(join(s.cwd, docPath), contents)
    await s.git('add', '--', docPath)
    await s.git('commit', '-m', 'Write design')
    await s.git('bundle', 'create', s.bundle, `${s.base}..${s.ref}`)
  }
  const tip = await s.git('rev-parse', 'HEAD')
  const savePlan = () => writeFile(join(s.out, 'plan.json'), JSON.stringify(plan))
  const saveResult = (outcome: Parameters<typeof writeOutResult>[1]['outcome'] = 'planned') =>
    writeOutResult(s.out, { contract: 2, branch, head: tip, commits: docPath ? 1 : 0, outcome })
  await savePlan()
  await saveResult()
  const posts: { path: string; body: Record<string, unknown> }[] = []
  let failCreate = false
  let linkError: string | undefined
  const command: Command = async (args, opts) => {
    if (args[0] === 'git') return s.options.command(args, opts)
    const path = args[4]!
    expect(args).toEqual(['gh', 'api', '-X', 'POST', path, '--input', '-'])
    expect(opts?.env?.GH_TOKEN).toBe(repo.token)
    const body = JSON.parse(opts!.input!)
    posts.push({ path, body })
    if (path === 'repos/a/b/issues') {
      const i = plan.children.findIndex(({ title }) => title === body.title)
      expect(i).toBeGreaterThanOrEqual(0)
      if (failCreate && i === 1) {
        failCreate = false
        throw new Error('HTTP 503')
      }
      return JSON.stringify({ number: 101 + i, id: 1001 + i })
    }
    expect(path).toBe('repos/a/b/issues/42/sub_issues')
    if (linkError) {
      const message = linkError
      linkError = undefined
      throw new Error(message)
    }
    return ''
  }
  return {
    ...s,
    db,
    plan,
    posts,
    tip,
    savePlan,
    saveResult,
    land: () => landRun({ ...s.options, run: record, command }),
    failSecondCreate: () => {
      failCreate = true
    },
    failNextLink: (error: string) => {
      linkError = error
    },
  }
}

test.each([true, false])('拆解有文档提交=%s 时按顺序创建并挂上子 Issue', async (hasDocs) => {
  const s = await planScenario(hasDocs ? 'Design.MD' : undefined)
  const result = await s.land()
  expect(result).toEqual({
    status: 'planned',
    branch: hasDocs ? branch : null,
    children: [
      { number: 101, title: '甲' },
      { number: 102, title: '乙' },
      { number: 103, title: '丙' },
    ],
  })
  expect(s.posts).toEqual(
    s.plan.children.flatMap(({ title, body }, i) => [
      {
        path: 'repos/a/b/issues',
        body: {
          title,
          body: `${body}${hasDocs ? `\n\n分支：${branch}` : ''}\n\n<!-- workling:plan parent=#42 run=1 -->`,
        },
      },
      { path: 'repos/a/b/issues/42/sub_issues', body: { sub_issue_id: 1001 + i } },
    ]),
  )
  expect(s.db.select().from(planChildren).orderBy(planChildren.position).all()).toMatchObject([
    { position: 1, githubId: 1001, linkedAt: expect.any(Date) },
    { position: 2, githubId: 1002, linkedAt: expect.any(Date) },
    { position: 3, githubId: 1003, linkedAt: expect.any(Date) },
  ])
  expect(s.calls.filter(({ args }) => args.includes('push'))).toHaveLength(hasDocs ? 1 : 0)
  expect(await s.remote.write(['for-each-ref', '--format=%(objectname)', s.ref])).toBe(
    hasDocs ? s.tip : '',
  )
})

test.each([
  ['非文档文件', 'code.ts', '拆解运行只能提交文档：code.ts'],
  ['文档路径不存在', 'design.md', 'plan.json 列出的文档不存在：missing.md'],
  ['无提交但清单列文档', undefined, '没有文档提交，但 plan.json 列出了文档'],
  ['子 Issue 缺少验收', undefined, '缺少「验收」'],
  ['子 Issue 有分支指令', undefined, '不能包含「分支：」行'],
  ['子 Issue 有模式指令', undefined, '不能包含「模式：」行'],
  ['子 Issue 末尾围栏未闭合', 'design.md', '正文末尾有未闭合的代码块'],
  ['拆解摘要命中密钥', undefined, '拆解产出命中密钥规则：API key'],
  ['子 Issue 标题命中密钥', undefined, '拆解产出命中密钥规则：API key'],
  ['子 Issue 正文命中密钥', undefined, '拆解产出命中密钥规则：API key'],
  ['拆解评论尾部命中密钥', undefined, '拆解产出命中密钥规则：API key'],
  ['文档提交命中密钥', 'design.md', '新增内容命中密钥规则：API key'],
] as const)('%s 时整批落地失败，无推送或子 Issue', async (name, path, reason) => {
  const secret = `sk-${'a'.repeat(24)}`
  const s = await planScenario(path, name === '文档提交命中密钥' ? secret : undefined)
  const second = s.plan.children[1]!
  if (name === '文档路径不存在' || name === '无提交但清单列文档') s.plan.docs = ['missing.md']
  if (name === '子 Issue 缺少验收') second.body = '## 目标\n单一目标'
  if (name === '子 Issue 有分支指令') second.body += '\n分支：docs/custom'
  if (name === '子 Issue 有模式指令') second.body += '\n模式：拆解'
  if (name === '子 Issue 末尾围栏未闭合') second.body += '\n```'
  if (name === '拆解摘要命中密钥') s.plan.summary = secret
  if (name === '子 Issue 标题命中密钥') second.title = secret
  if (name === '子 Issue 正文命中密钥') second.body += `\n${secret}`
  if (name === '拆解评论尾部命中密钥')
    await writeFile(join(s.out, 'issue-comment.md'), `${'x'.repeat(60_010)}\n${secret}`)
  await s.savePlan()
  const result = await s.land()
  expect(result.status).toBe('failed')
  expect(JSON.stringify(result)).toContain(reason)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(s.posts).toEqual([])
  expect(s.db.select().from(planChildren).all()).toEqual([])
  expect(s.calls.some(({ args }) => args.includes('push'))).toBe(false)
})

test('第二个子 Issue 创建失败后，从失败位置重新落地，保留挂载顺序', async () => {
  const s = await planScenario('design.md')
  s.failSecondCreate()
  await expect(s.land()).rejects.toThrow('HTTP 503')
  expect(s.db.select().from(planChildren).all()).toMatchObject([
    { position: 1, linkedAt: expect.any(Date) },
  ])
  await expect(s.land()).resolves.toMatchObject({ status: 'planned' })
  expect(s.posts.map(({ body }) => body.title ?? body.sub_issue_id)).toEqual([
    '甲',
    1001,
    '乙',
    '乙',
    1002,
    '丙',
    1003,
  ])
  expect(s.calls.filter(({ args }) => args.includes('push'))).toHaveLength(1)
})

test('挂载失败保留已创建的子 Issue，仅将明确挂在同一父 Issue 的 422 视为成功', async () => {
  const s = await planScenario()
  s.failNextLink('gh: Sub-issue is already added to another parent issue (HTTP 422)')
  await expect(s.land()).rejects.toThrow('HTTP 422')
  expect(s.db.select().from(planChildren).all()).toMatchObject([{ position: 1, linkedAt: null }])
  s.failNextLink('gh: The sub-issue is already a sub-issue of this issue (HTTP 422)')
  await expect(s.land()).resolves.toMatchObject({ status: 'planned' })
  expect(s.posts.map(({ body }) => body.title ?? body.sub_issue_id)).toEqual([
    '甲',
    1001,
    1001,
    '乙',
    1002,
    '丙',
    1003,
  ])
  expect(
    s.db.select().from(planChildren).where(eq(planChildren.position, 1)).get()?.linkedAt,
  ).toBeInstanceOf(Date)
})

test('拆解运行接受答复，拒绝其他运行类型的结果', async () => {
  const s = await planScenario()
  await s.saveResult('answered')
  expect(await s.land()).toEqual({ status: 'answered' })
  for (const outcome of ['completed', 'partial', 'incomplete', 'reviewed'] as const) {
    await s.saveResult(outcome)
    expect(await s.land()).toEqual({ status: 'failed', error: `拆解运行的结果无效：${outcome}` })
  }
  expect(s.posts).toEqual([])
})

test('部分完成评论保留下步，待办文件无法读取仍发送并截断超长说明', async () => {
  const taskDir = await mkdtemp(join(tmpdir(), 'workling-issue-result-'))
  dirs.push(taskDir)
  const out = join(taskDir, 'out')
  await mkdir(out)
  await writeFile(join(out, 'issue-comment.md'), '长'.repeat(maxCommentLength + 1))
  await writeFile(join(out, 'checklist.json'), '{')
  const calls: string[][] = []
  const logs: string[] = []
  let comment = ''
  await publishIssueResult({
    repo,
    issue,
    taskDir,
    landed: { ...landed('a'.repeat(40), true), created: false, prUrl: 'https://example.com/pr' },
    run: { ...commentRun, id: 9, round: 2, kind: 'rework', executor: 'mixed' },
    command: async (args, options) => {
      calls.push(args)
      comment = options?.input ?? ''
      return ''
    },
    llmApiKey: null,
    log: (line) => logs.push(line),
  })
  expect(calls).toEqual([['gh', 'issue', 'comment', '42', '-R', 'a/b', '--body-file', '-']])
  expect(logs).toEqual(['a/b #42 读取待办变更失败'])
  expect(
    comment.startsWith(
      '### 🟡 第 2 轮 · 返工 · 部分完成\n\nhttps://example.com/pr · 更新 · 1 个提交 · 用时 24 分钟 · Pi + codex 实现 · 运行 #9\n\n长',
    ),
  ).toBe(true)
  expect(comment).toEndWith(
    `\n\n（已截断）\n\n**下一步**：PR 为草稿。要继续时评论 \`/workling <补充说明>\`，或把剩余部分另开 Issue。\n\n\n${AI_NOTICE}\n\n<!-- workling -->`,
  )
  expect(comment.match(/（已截断）/g)).toHaveLength(1)
})
