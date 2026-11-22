import { AI_NOTICE, markComment, neutralizeMentions } from './comment.ts'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import {
  missingOutput,
  readChecklist,
  readIssueComment,
  readOutputFile,
  readOutResult,
  truncateComment,
  type OutResult,
} from '../contract/out.ts'
import { applyChecklist, planChecklist } from '../issue/checklist.ts'
import { defaultBranch as readDefaultBranch, ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
import { findSecrets, redactSecrets } from './secret-scan.ts'

const maxBundleBytes = 100_000_000
const maxTextLength = 60_000
const prsSchema = Type.Array(
  Type.Object({
    url: Type.String({ minLength: 1 }),
    state: Type.Literal('OPEN'),
    isDraft: Type.Boolean(),
  }),
)

type Landed = {
  status: 'done'
  prUrl: string
  prState: 'open'
  commits: number
  created: boolean
}
type LandResult = Landed | { status: 'answered' } | { status: 'failed'; error: string }

function failed(error: string): LandResult {
  return { status: 'failed', error }
}

async function readMarkdown(dir: string, name: string): Promise<string> {
  const text = (await readOutputFile(dir, name, maxTextLength * 3)).toString('utf8')
  if (text.length > maxTextLength) throw new Error(`out/${name} 超出大小限制`)
  return text
}

function preparePr(title: string, body: string, number: number, outcome: 'completed' | 'partial') {
  const closing = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \\t]*:?[ \\t]+#${number}(?![\\w/-])`,
    'i',
  )
  const refs = new RegExp(`^\\s*Refs[ \\t]+#${number}(?![\\w/-])`, 'i')
  const partial = outcome === 'partial' || (!closing.test(body) && refs.test(body))
  if (partial) {
    // 合入部分完成的 PR 不能自动关闭 Issue。
    const closingGlobal = new RegExp(closing.source, 'gi')
    body = body.replace(closingGlobal, `Refs #${number}`)
    if (!refs.test(body))
      body = `Refs #${number}\n> 部分完成：合入本 PR 不会关闭 #${number}，剩余工作见「未完成与存疑」。\n\n${body}`
    if (!title.startsWith('[部分完成]')) title = `[部分完成] ${title}`
  } else if (!closing.test(body)) {
    body = `Closes #${number}\n\n${body}`
  }
  return { title, body, partial }
}

export async function runOutDir(taskDir: string): Promise<string> {
  const out = join(taskDir, 'out')
  if (!(await lstat(taskDir)).isDirectory() || !(await lstat(out)).isDirectory())
    throw new Error('任务目录或 out/ 不是普通目录')
  return out
}

export async function readRunIssueComment(
  taskDir: string,
  warn: (step: string) => void,
): Promise<string> {
  try {
    return await readIssueComment(await runOutDir(taskDir))
  } catch (error) {
    if (!missingOutput(error)) warn('读取 Issue 说明')
    return ''
  }
}

const issueBodySchema = Type.Object({ body: Type.String() })

export async function publishIssueResult({
  repo,
  issue,
  taskDir,
  landed,
  command,
  llmApiKey,
  log,
}: {
  repo: { host: string; path: string; token: string }
  issue: { number: number }
  taskDir: string
  landed: Landed
  command: Command
  llmApiKey: string | null
  log: (message: string) => void
}): Promise<void> {
  const env = ghEnv(repo.token, repo.host)
  const args = [String(issue.number), '-R', repo.path]
  const warn = (step: string) => log(`${repo.path} #${issue.number} ${step}失败`)
  const gh = (operation: string, flags: string[], input?: string) =>
    command(['gh', 'issue', operation, ...args, ...flags], { env, input, quietStderr: true })
  const comment = (text: string) =>
    gh(
      'comment',
      ['--body-file', '-'],
      markComment(neutralizeMentions(redactSecrets(text, [repo.token, llmApiKey ?? '']))),
    )
  const explanation = await readRunIssueComment(taskDir, warn)
  const header = landed.created
    ? `workling：已创建 PR ${landed.prUrl}（${landed.commits} 个提交）`
    : `workling：已更新 PR ${landed.prUrl}（本次 ${landed.commits} 个提交）`
  try {
    await comment(explanation ? truncateComment(`${header}\n\n${explanation}`) : header)
  } catch {
    warn('发送 Issue 评论')
  }

  let step = '读取待办变更'
  try {
    const items = await readChecklist(await runOutDir(taskDir))
    if (!items.length) return
    const readBody = async () => {
      const value: unknown = JSON.parse(await gh('view', ['--json', 'body']))
      if (!Value.Check(issueBodySchema, value)) throw new Error('Issue 正文格式无效')
      return value.body
    }
    step = '读取 Issue 正文'
    const { changes, skipped } = planChecklist(await readBody(), items)
    if (!changes.length) return
    const reasons = { missing: '找不到原文行', ambiguous: '匹配多行', unchanged: '已是目标状态' }
    const details = changes.map(
      ({ line, checked, evidence }) =>
        `- ${checked ? '勾选' : '取消勾选'}：${line}\n  - 依据：${evidence}`,
    )
    for (const { item, reason } of skipped)
      details.push(`- 跳过：${item.line}（${reasons[reason]}）`)
    step = '发送待办变更评论'
    await comment(`workling：即将更新 Issue 待办\n\n${details.join('\n')}`)
    step = '重新读取 Issue 正文'
    const latest = await readBody()
    const updated = applyChecklist(latest, changes)
    if (updated === latest) return
    step = '更新 Issue 待办'
    await gh('edit', ['--body-file', '-'], updated)
  } catch (error) {
    if (step !== '读取待办变更' || !missingOutput(error)) warn(step)
  }
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
  run: {
    id: number
    taskDir: string | null
    branch: string | null
    baseRef: string | null
    stackBranch?: string | null
  }
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

    let bundle: Buffer
    let body: string
    let comment: string | undefined
    let outcome: Extract<OutResult['outcome'], 'completed' | 'partial'>
    try {
      const out = await runOutDir(run.taskDir)
      const result = await readOutResult(out)
      if (result.outcome === 'answered') {
        if (result.commits > 0) log(`${repo.path} #${issue.number} 答复模式下存在提交，已忽略`)
        return { status: 'answered' }
      }
      if (result.commits === 0) return failed(`没有可交付的提交（outcome: ${result.outcome}）`)
      outcome = result.outcome === 'incomplete' ? 'partial' : result.outcome
      bundle = await readOutputFile(out, 'commits.bundle', maxBundleBytes).catch(
        (error: unknown) => {
          if (missingOutput(error)) throw new Error('缺少 out/commits.bundle')
          throw error
        },
      )
      body = await readMarkdown(out, 'pr-body.md').catch((error: unknown) => {
        if (missingOutput(error)) throw new Error('缺少 out/pr-body.md')
        throw error
      })
      try {
        comment = await readMarkdown(out, 'pr-comment.md')
      } catch (error) {
        if (!missingOutput(error)) warn('读取 PR 评论')
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
    let pushed = false
    if (remote !== `${tip}\t${ref}`) {
      if (remote && remote !== `${baseRef}\t${ref}`)
        return failed('远端分支已更新，与本次基点不一致')
      await remoteGit('push', '--', remoteUrl, `${tip}:${ref}`)
      pushed = true
    }

    const prs: unknown = JSON.parse(
      await gh([
        'pr',
        'list',
        '-R',
        repo.path,
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'url,state,isDraft',
      ]),
    )
    if (!Value.Check(prsSchema, prs)) throw new Error('PR 列表格式无效')
    const existing = prs[0]
    if (existing && !pushed)
      return { status: 'done', prUrl: existing.url, prState: 'open', commits, created: false }

    const prFields = async () =>
      preparePr(
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
          ])),
        neutralizeMentions(redactSecrets(body, secrets)),
        issue.number,
        outcome,
      )
    let prUrl: string
    if (existing) {
      prUrl = existing.url
      try {
        const { title, body } = await prFields()
        await gh(['pr', 'edit', prUrl, '--title', title, '--body-file', '-'], withAiNotice(body))
      } catch {
        warn('更新 PR')
      }
      if (outcome === 'completed' && existing.isDraft) {
        try {
          await gh(['pr', 'ready', prUrl])
        } catch {
          warn('将 PR 标记为可审查')
        }
      }
    } else {
      const base = run.stackBranch ?? (await readDefaultBranch({ repo, command }))
      if (!base) throw new Error('无法读取仓库默认分支')
      const { title, body, partial } = await prFields()
      prUrl = await gh(
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
          ...(partial ? ['--draft'] : []),
        ],
        withAiNotice(
          run.stackBranch
            ? `${body}\n\n堆叠于 #${run.stackBranch.match(/^workling\/(\d+)-/)?.[1] ?? '?'} 的分支 \`${run.stackBranch}\`，请先审阅并合并上游 PR。`
            : body,
        ),
      )
      if (!prUrl) throw new Error('创建 PR 未返回链接')
    }
    if (comment) {
      try {
        await gh(
          ['pr', 'comment', prUrl, '--body-file', '-'],
          markComment(neutralizeMentions(redactSecrets(`workling：${comment}`, secrets))),
        )
      } catch {
        warn('发送 PR 评论')
      }
    }
    return { status: 'done', prUrl, prState: 'open', commits, created: !existing }
  } finally {
    await rm(landing, { recursive: true, force: true })
  }
}

function withAiNotice(body: string): string {
  let text = body.trimEnd()
  while (text === AI_NOTICE || text.endsWith(`\n${AI_NOTICE}`))
    text = text.slice(0, -AI_NOTICE.length).trimEnd()
  return `${text}\n\n\n${AI_NOTICE}`
}
