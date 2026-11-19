import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOutResult } from '../src/contract/out.ts'
import type { Command, RunOptions } from '../src/runtime/types.ts'
import { landRun, publishIssueResult } from '../src/serve/land.ts'
import { localRemote } from './helpers/git.ts'

const issue = { number: 42, title: 'Ship this' }
const repo = { host: 'github.com', path: 'a/b', token: 'configured-test-secret' }
const prUrl = 'https://github.com/a/b/pull/3'
const landed = { status: 'done', prUrl, prState: 'open', commits: 1 } as const
const branch = 'workling/42-task'
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function scenario(taskBranch = branch) {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-land-'))
  dirs.push(workspace)
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
  let existing = false
  const command: Command = async (args, options) => {
    calls.push({ args, options })
    if (args[0] === 'git') {
      expect(options?.cwd).toBe(landing)
      if (args.includes('ls-remote') || args.includes('push')) {
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
    if (args[2] === 'list') return JSON.stringify(existing ? [{ url: prUrl, state: 'OPEN' }] : [])
    if (args[2] === 'create') {
      existing = true
      return prUrl
    }
    return ''
  }
  const options = {
    workspace,
    repo,
    issue,
    mirror,
    command,
    remoteUrl: remote.path,
    run: { id: 1, taskDir, branch: taskBranch, baseRef: base },
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
    await writeOutResult(out, { contract: 1, outcome, branch: taskBranch, head: tip, commits })
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
  expect(result).toEqual(landed)
  await writeFile(join(s.out, 'issue-comment.md'), '@someone: checks passed.')
  await publishIssueResult({ ...s.options, taskDir: s.options.run.taskDir, landed })
  expect(await s.remote.write(['rev-parse', s.ref])).toBe(tip)
  expect(await landRun(s.options)).toEqual(landed)
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
  expect(creates[0]?.options?.input).toBe('Closes #42\n\nThanks `@someone` and `@org/team`.')
  expect(
    s.calls
      .filter(({ args }) => args[2] === 'comment')
      .map(({ args, options }) => [args[1], options?.input]),
  ).toEqual([
    ['pr', 'workling：Checked by `@reviewer`.'],
    ['issue', `workling：已创建 PR ${prUrl}（1 个提交）\n\n\`@someone\`: checks passed.`],
  ])
})

test('部分完成结果会替换关闭关键字并标记 PR 标题', async () => {
  const s = await scenario()
  await s.commit()
  await s.deliver({ outcome: 'partial' })
  await writeFile(join(s.out, 'pr-body.md'), 'Closes #42 done')

  expect(await landRun(s.options)).toEqual(landed)
  const create = s.calls.find(({ args }) => args[2] === 'create')
  expect(create?.args[create.args.indexOf('--title') + 1]).toBe('[部分完成] Ship this')
  expect(create?.options?.input).not.toContain('Closes #42')
  expect(create?.options?.input).toContain('Refs #42')
})

test('正文以 Refs 开头时按部分完成处理且不前置 Closes', async () => {
  const s = await scenario()
  await s.commit()
  await s.deliver()
  await writeFile(join(s.out, 'pr-body.md'), 'Refs #42\n> 部分完成：后续处理')

  expect(await landRun(s.options)).toEqual(landed)
  const create = s.calls.find(({ args }) => args[2] === 'create')
  expect(create?.args[create.args.indexOf('--title') + 1]).toBe('[部分完成] Ship this')
  expect(create?.options?.input).toBe('Refs #42\n> 部分完成：后续处理')
})

test.each([
  ['incomplete', '没有可交付的提交（outcome: incomplete）'],
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
  ['远端分支冲突', '远端已存在同名分支'],
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
  if (kind === '远端分支冲突') await s.remote.commit(s.ref, 'other', s.base)
  await s.deliver({
    outcome: kind === 'incomplete' ? 'incomplete' : 'completed',
    extraRef: kind === '多个引用' ? 'refs/heads/extra' : undefined,
    prerequisite: kind === '非基点后代' ? null : undefined,
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
  expect(await landRun(s.options)).toEqual(landed)
  expect(s.calls.filter(({ args }) => args.includes('push'))).toHaveLength(1)
  expect(s.calls.find(({ args }) => args[2] === 'create')?.options?.input).toBe(
    'fIxEs #42 by `@someone`',
  )
})

test('有原文反引号时转义提及；两条评论失败只记录，不影响落地也不重发', async () => {
  const s = await scenario()
  await s.commit()
  await s.deliver()
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
  expect(await landRun(options)).toEqual(landed)
  await publishIssueResult({ ...options, taskDir: options.run.taskDir, landed })
  expect(s.calls.find(({ args }) => args[2] === 'create')?.options?.input).toBe(
    'Closes #42\n\n`example <code>&#64;inside</code>` thanks <code>&#64;someone</code>',
  )
  expect(await landRun(options)).toEqual(landed)
  expect(s.logs).toEqual(['a/b #42 发送 PR 评论失败', 'a/b #42 发送 Issue 评论失败'])
  expect(attempts).toBe(2)
})
