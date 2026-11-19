import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { readOutputFile, readOutResult } from '../contract/out.ts'
import { ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
import { findSecrets, redactSecrets } from './secret-scan.ts'

const maxBundleBytes = 100_000_000
const maxTextLength = 60_000
const prStates = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const
const prsSchema = Type.Array(
  Type.Object({
    url: Type.String({ minLength: 1 }),
    state: Type.Union([Type.Literal('OPEN'), Type.Literal('MERGED'), Type.Literal('CLOSED')]),
  }),
)

type LandResult =
  | { status: 'done'; prUrl: string; prState: (typeof prStates)[keyof typeof prStates] }
  | { status: 'failed'; error: string }

function failed(error: string): LandResult {
  return { status: 'failed', error }
}

function neutralizeMentions(text: string): string {
  // 现有反引号可能和新插入的反引号配对，使提及落到代码之外。
  const useHtml = text.includes('`') || /\\@|@[A-Za-z0-9_/-]*@/.test(text)
  return text.replace(/\\?@([A-Za-z0-9-]+(?:\/[A-Za-z0-9_-]+)?)/g, (_, name: string) =>
    useHtml ? `<code>&#64;${name}</code>` : `\`@${name}\``,
  )
}

async function readMarkdown(dir: string, name: string): Promise<string> {
  const text = (await readOutputFile(dir, name, maxTextLength * 3)).toString('utf8')
  if (text.length > maxTextLength) throw new Error(`out/${name} 超出大小限制`)
  return text
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function landRun({
  workspace,
  repo,
  issue,
  run,
  mirror,
  command,
  remoteUrl = `https://${repo.host}/${repo.path}.git`,
  llmApiKey = '',
  log = console.warn,
}: {
  workspace: string
  repo: { host: string; path: string; token: string }
  issue: { number: number; title: string | null }
  run: { id: number; taskDir: string | null; branch: string | null; baseRef: string | null }
  mirror: string
  command: Command
  remoteUrl?: string
  llmApiKey?: string | null
  log?: (message: string) => void
}): Promise<LandResult> {
  const landing = resolve(workspace, 'landing', `${run.id}.git`)
  const env = ghEnv(repo.token, repo.host)
  const secrets = [repo.token, llmApiKey ?? '']
  // 只在主体创建的 bare 仓库里运行 Git；worker 的 Git 配置和 hooks 不可信。
  const git = (...args: string[]) => command(['git', ...args], { cwd: landing, quietStderr: true })
  const remoteGit = (...args: string[]) =>
    command(
      [
        'git',
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        ...args,
      ],
      { cwd: landing, env, quietStderr: true },
    )
  const gh = (args: string[], input?: string) => command(['gh', ...args], { env, input })
  const warn = (step: string) => log(`${repo.path} #${issue.number} ${step}失败`)

  await rm(landing, { recursive: true, force: true })
  try {
    if (!run.taskDir) return failed('缺少任务目录')
    const { branch, baseRef } = run
    if (!branch) return failed('缺少分支记录')
    if (!baseRef || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseRef))
      return failed('缺少有效的基点记录')

    const out = join(run.taskDir, 'out')
    let bundle: Buffer
    let body: string
    let comment: string | undefined
    let outcome: string | undefined
    try {
      if (!(await lstat(run.taskDir)).isDirectory() || !(await lstat(out)).isDirectory())
        return failed('任务目录或 out/ 不是普通目录')
      const result = await readOutResult(out)
      outcome = result.outcome
      if (result.outcome === 'incomplete' || result.commits === 0)
        return failed(`没有可交付的提交（outcome: ${result.outcome}）`)
      bundle = await readOutputFile(out, 'commits.bundle', maxBundleBytes).catch(
        (error: unknown) => {
          if (missing(error)) throw new Error('缺少 out/commits.bundle')
          throw error
        },
      )
      body = await readMarkdown(out, 'pr-body.md').catch((error: unknown) => {
        if (missing(error)) throw new Error('缺少 out/pr-body.md')
        throw error
      })
      try {
        comment = await readMarkdown(out, 'pr-comment.md')
      } catch (error) {
        if (!missing(error)) warn('读取 PR 评论')
      }
    } catch (error) {
      return failed(redactSecrets(errorMessage(error), secrets))
    }

    const ref = `refs/heads/${branch}`
    if (!branch.startsWith(`workling/${issue.number}-`))
      return failed('任务分支不在 Issue 命名空间内')
    await mkdir(landing, { recursive: true, mode: 0o700 })
    await git(
      'init',
      '--bare',
      '--template=',
      `--object-format=${baseRef.length === 64 ? 'sha256' : 'sha1'}`,
      '.',
    )
    await writeFile(join(landing, 'objects/info/alternates'), `${resolve(mirror, 'objects')}\n`)
    // 用主体保存的副本校验和导入同一份 bundle，避免 worker 替换其路径或内容。
    const bundlePath = join(landing, 'commits.bundle')
    await writeFile(bundlePath, bundle, { mode: 0o600 })
    let tip: string
    try {
      await git('check-ref-format', ref)
      const heads = await git('bundle', 'list-heads', bundlePath)
      const oid = heads.split(' ', 1)[0]!
      if (oid.length !== baseRef.length || !/^[0-9a-f]+$/.test(oid) || heads !== `${oid} ${ref}`)
        return failed('提交包必须恰好包含一个与记录一致的任务分支引用')
      await git('-c', 'fetch.fsckObjects=true', 'fetch', '--no-tags', bundlePath, `${ref}:${ref}`)
      tip = await git('rev-parse', '--verify', `${ref}^{commit}`)
    } catch {
      return failed('提交包无效或无法导入')
    }
    try {
      await git('merge-base', '--is-ancestor', baseRef, tip)
    } catch {
      return failed('任务分支最新提交不以记录的基点为祖先')
    }
    const range = `${baseRef}..${tip}`
    const commits = Number(await git('rev-list', '--count', range))
    if (commits === 0) return failed('没有可交付的提交（与记录的基点相同）')
    const workflows = await git(
      'log',
      '--full-history',
      '-m',
      '--no-renames',
      '--format=',
      '--name-only',
      '-z',
      range,
      '--',
      '.github/workflows/',
    )
    const paths = [
      ...new Set(workflows.split('\0').filter((path) => path.startsWith('.github/workflows/'))),
    ]
    if (paths.length)
      return failed(
        `禁止修改 GitHub Actions 工作流：${paths.map((path) => redactSecrets(path, secrets)).join('、')}`,
      )

    const patch = await git(
      'log',
      '-m',
      '-p',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--format=',
      range,
    )
    const hits = findSecrets(patch, secrets)
    if (hits.length)
      return failed(
        `新增内容命中密钥规则：${hits.map(({ rule, file }) => `${rule}（${file}）`).join('、')}`,
      )

    const remote = (await remoteGit('ls-remote', '--heads', '--', remoteUrl, ref))
      .split('\n')
      .find((line) => line.endsWith(`\t${ref}`))
    if (!remote) await remoteGit('push', '--', remoteUrl, `${tip}:${ref}`)
    else if (remote !== `${tip}\t${ref}`) return failed('远端已存在同名分支')

    const prs: unknown = JSON.parse(
      await gh([
        'pr',
        'list',
        '-R',
        repo.path,
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'url,state',
      ]),
    )
    if (!Value.Check(prsSchema, prs)) throw new Error('PR 列表格式无效')
    const existing = prs[0]
    if (existing) return { status: 'done', prUrl: existing.url, prState: prStates[existing.state] }

    const base = await gh(['api', `repos/${repo.path}`, '--jq', '.default_branch'])
    if (!base) throw new Error('无法读取仓库默认分支')
    let title =
      issue.title ??
      (await gh([
        'issue',
        'view',
        String(issue.number),
        '-R',
        repo.path,
        '--json',
        'title',
        '--jq',
        '.title',
      ]))
    body = neutralizeMentions(redactSecrets(body, secrets))
    const closing = new RegExp(
      `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \\t]*:?[ \\t]+#${issue.number}(?![\\w/-])`,
      'i',
    )
    const refs = new RegExp(`^\\s*Refs[ \\t]+#${issue.number}(?![\\w/-])`, 'i')
    const partial = outcome === 'partial' || (!closing.test(body) && refs.test(body))
    if (partial) {
      // 合入部分完成的 PR 不能自动关闭 Issue。
      const closingGlobal = new RegExp(closing.source, 'gi')
      body = body.replace(closingGlobal, `Refs #${issue.number}`)
      if (!refs.test(body))
        body = `Refs #${issue.number}\n> 部分完成：合入本 PR 不会关闭 #${issue.number}，剩余工作见「未完成与存疑」。\n\n${body}`
      if (!title.startsWith('[部分完成]')) title = `[部分完成] ${title}`
    } else if (!closing.test(body)) {
      body = `Closes #${issue.number}\n\n${body}`
    }
    const prUrl = await gh(
      [
        'pr',
        'create',
        '-R',
        repo.path,
        '--head',
        branch,
        '--base',
        base,
        '--title',
        title,
        '--body-file',
        '-',
      ],
      body,
    )
    if (!prUrl) throw new Error('创建 PR 未返回链接')
    // 已有 PR 的重试直接返回，避免重复发送评论。
    if (comment)
      await gh(
        ['pr', 'comment', prUrl, '--body-file', '-'],
        neutralizeMentions(redactSecrets(comment, secrets)),
      ).catch(() => warn('发送 PR 评论'))
    await gh(
      ['issue', 'comment', String(issue.number), '-R', repo.path, '--body-file', '-'],
      `workling：已创建 PR ${prUrl}（${commits} 个提交）`,
    ).catch(() => warn('发送 Issue 评论'))
    return { status: 'done', prUrl, prState: 'open' }
  } finally {
    await rm(landing, { recursive: true, force: true })
  }
}
