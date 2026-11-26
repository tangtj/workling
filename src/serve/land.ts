import {
  AI_NOTICE,
  formatDuration,
  markComment,
  neutralizeMentions,
  normalizeBody,
  runComment,
  runKindLabel,
} from './comment.ts'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import {
  missingOutput,
  readChecklist,
  readIssueComment,
  readOutputFile,
  readOutResult,
  type OutResult,
  type Plan,
} from '../contract/out.ts'
import type { WorklingDatabase } from '../db/index.ts'
import type { runs } from '../db/schema.ts'
import { applyChecklist, planChecklist } from '../issue/checklist.ts'
import { defaultBranch as readDefaultBranch, ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
import { findSecrets, redactSecrets } from './secret-scan.ts'
import { createPlanChildren, preparePlan } from './land-plan.ts'

const maxBundleBytes = 100_000_000
const maxTextLength = 60_000
const prsSchema = Type.Array(
  Type.Object({
    url: Type.String({ minLength: 1 }),
    state: Type.Literal('OPEN'),
    isDraft: Type.Boolean(),
  }),
)
const mergedPrsSchema = Type.Array(Type.Object({ number: Type.Integer({ minimum: 1 }) }))

type Landed = {
  status: 'done'
  prUrl: string
  prState: 'open'
  commits: number
  head: string
  partial: boolean
  created: boolean
  restacked?: { baseRef: string }
}
type Planned = {
  status: 'planned'
  branch: string | null
  children: { number: number; title: string }[]
}
type LandResult = Landed | Planned | { status: 'answered' } | { status: 'failed'; error: string }

function failed(error: string): LandResult {
  return { status: 'failed', error }
}

async function readMarkdown(dir: string, name: string): Promise<string> {
  const text = (await readOutputFile(dir, name, maxTextLength * 3)).toString('utf8')
  if (text.length > maxTextLength) throw new Error(`out/${name} 超出大小限制`)
  return text
}

function preparePr(body: string, number: number, outcome: 'completed' | 'partial') {
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
  } else if (!closing.test(body)) {
    body = `Closes #${number}\n\n${body}`
  }
  return { body, partial }
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

function checklistTail({ changes, skipped }: ReturnType<typeof planChecklist>): string {
  const checked = changes.filter((item) => item.checked).length
  const unchecked = changes.length - checked
  const counts = [
    checked && `勾选 ${checked} 项`,
    unchecked && `取消 ${unchecked} 项`,
    skipped.length && `跳过 ${skipped.length} 项`,
  ].filter(Boolean)
  const reasons = { missing: '找不到原文行', ambiguous: '匹配多行', unchanged: '已是目标状态' }
  const itemText = (line: string) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s*/, '')
  const details = changes.map(
    ({ line, checked, evidence }) =>
      `- ${checked ? '☑' : '☐'} ${itemText(line)}${checked ? '' : '（取消勾选）'}\n  - 依据：${evidence.replace(/\s+/g, ' ')}`,
  )
  for (const { item, reason } of skipped)
    details.push(`- 跳过：${itemText(item.line)}（${reasons[reason]}）`)
  return `**验收勾选**：${counts.join('，')}\n\n<details><summary>逐项依据</summary>\n\n${details.join('\n')}\n\n</details>`
}

export async function publishIssueResult({
  repo,
  issue,
  taskDir,
  landed,
  run,
  command,
  llmApiKey,
  log,
}: {
  repo: { host: string; path: string; token: string }
  issue: { number: number }
  taskDir: string
  landed: Landed
  run: Pick<typeof runs.$inferSelect, 'id' | 'kind' | 'startedAt' | 'executor'> & {
    round: number
    endedAt: Date
  }
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
  const explanation = normalizeBody(await readRunIssueComment(taskDir, warn))
  const readBody = async () => {
    const value: unknown = JSON.parse(await gh('view', ['--json', 'body']))
    if (!Value.Check(issueBodySchema, value)) throw new Error('Issue 正文格式无效')
    return value.body
  }
  let checklist: ReturnType<typeof planChecklist> | undefined
  let step = '读取待办变更'
  try {
    const items = await readChecklist(await runOutDir(taskDir))
    step = '读取 Issue 正文'
    if (items.length) checklist = planChecklist(await readBody(), items)
  } catch (error) {
    if (step !== '读取待办变更' || !missingOutput(error)) warn(step)
  }

  const pr = /\/pull\/(\d+)$/.exec(landed.prUrl)
  const executors = { pi: 'Pi 实现', codex: 'codex 实现', mixed: 'Pi + codex 实现' }
  const { partial } = landed
  try {
    await comment(
      runComment({
        title: `${partial ? '🟡' : '✅'} 第 ${run.round} 轮 · ${runKindLabel[run.kind]} · ${partial ? '部分完成' : '完成'}`,
        facts: [
          pr ? `[PR #${pr[1]}](${landed.prUrl})` : landed.prUrl,
          landed.created ? '新建' : '更新',
          `${landed.commits} 个提交`,
          formatDuration(run.startedAt, run.endedAt),
          ...(run.executor ? [executors[run.executor]] : []),
          `运行 #${run.id}`,
        ],
        body: explanation,
        tail: checklist?.changes.length ? checklistTail(checklist) : undefined,
        next: partial
          ? 'PR 为草稿。要继续时评论 `/workling <补充说明>`，或把剩余部分另开 Issue。'
          : '评审并合并 PR。需要修改时在 PR 或本 Issue 评论 `/workling <说明>`。',
      }),
    )
  } catch {
    warn('发送 Issue 评论')
    return
  }

  if (!checklist?.changes.length) return
  step = '重新读取 Issue 正文'
  try {
    const latest = await readBody()
    const updated = applyChecklist(latest, checklist.changes)
    if (updated === latest) return
    step = '更新 Issue 待办'
    await gh('edit', ['--body-file', '-'], updated)
  } catch {
    warn(step)
  }
}

export async function landRun({
  db,
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
  db: WorklingDatabase
  workspace: string
  repo: { host: string; path: string; token: string }
  issue: { number: number; title: string | null }
  run: {
    id: number
    kind: typeof runs.$inferSelect.kind
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
  // Git 只在主体创建的仓库里运行，避免使用 worker 的配置和 hooks。
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

    let bundle: Buffer | undefined
    let plan: Plan | undefined
    let pr:
      | { body: string; outcome: Extract<OutResult['outcome'], 'completed' | 'partial'> }
      | undefined
    let comment: string | undefined
    try {
      const out = await runOutDir(run.taskDir)
      const result =
        run.kind === 'plan'
          ? await readOutResult(out, { allowPlan: true }).catch(async (error: unknown) => {
              // 评审结果结构有效，但不属于拆解运行。
              try {
                return await readOutResult(out, { allowReview: true })
              } catch {
                throw error
              }
            })
          : await readOutResult(out)
      if (result.outcome === 'answered') {
        if (result.commits > 0) log(`${repo.path} #${issue.number} 答复模式下存在提交，已忽略`)
        return { status: 'answered' }
      }
      if (run.kind === 'plan') {
        if (result.outcome !== 'planned') return failed(`拆解运行的结果无效：${result.outcome}`)
        plan = await preparePlan(
          out,
          issue.number,
          run.id,
          result.commits > 0 ? branch : null,
          secrets,
        )
      } else {
        if (result.commits === 0) return failed(`没有可交付的提交（outcome: ${result.outcome}）`)
      }
      if (result.commits > 0)
        bundle = await readOutputFile(out, 'commits.bundle', maxBundleBytes).catch(
          (error: unknown) => {
            if (missingOutput(error)) throw new Error('缺少 out/commits.bundle')
            throw error
          },
        )
      if (run.kind !== 'plan') {
        if (
          result.outcome !== 'completed' &&
          result.outcome !== 'partial' &&
          result.outcome !== 'incomplete'
        )
          return failed('out/result.json 的结构无效')
        const body = await readMarkdown(out, 'pr-body.md').catch((error: unknown) => {
          if (missingOutput(error)) throw new Error('缺少 out/pr-body.md')
          throw error
        })
        pr = { body, outcome: result.outcome === 'incomplete' ? 'partial' : result.outcome }
        try {
          comment = await readMarkdown(out, 'pr-comment.md')
        } catch (error) {
          if (!missingOutput(error)) warn('读取 PR 评论')
        }
      }
    } catch (error) {
      return failed(redactSecrets(errorMessage(error), secrets))
    }

    const publishPlan = async (plan: Plan, branch: string | null): Promise<Planned> => ({
      status: 'planned',
      branch,
      children: await createPlanChildren({
        db,
        gh,
        path: repo.path,
        parent: issue.number,
        runId: run.id,
        plan,
      }),
    })
    if (plan && !bundle) return await publishPlan(plan, null)
    if (!bundle) return failed('缺少 out/commits.bundle')

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

    if (plan) {
      const changed = await git(
        'log',
        '-m',
        '--no-renames',
        '--format=',
        '--name-only',
        '-z',
        range,
      )
      const nonDocs = [
        ...new Set(
          changed
            .split('\0')
            .filter((path) => path && !/\.(md|png|jpe?g|gif|svg|webp)$/i.test(path)),
        ),
      ]
      if (nonDocs.length)
        return failed(
          `拆解运行只能提交文档：${redactSecrets(nonDocs.slice(0, 10).join('、'), secrets)}`,
        )
    }

    const oldTip = tip
    let restacked: { baseRef: string; baseBranch: string; upstreamNumber: number } | undefined
    if (run.stackBranch) {
      const stackRef = `refs/heads/${run.stackBranch}`
      const upstream = (await remoteGit('ls-remote', '--heads', '--', remoteUrl, stackRef))
        .split('\n')
        .find((line) => line.endsWith(`\t${stackRef}`))
      if (!upstream) {
        const merged: unknown = JSON.parse(
          await gh([
            'pr',
            'list',
            '-R',
            repo.path,
            '--head',
            run.stackBranch,
            '--state',
            'merged',
            '--json',
            'number',
            '--limit',
            '1',
          ]),
        )
        if (!Value.Check(mergedPrsSchema, merged)) throw new Error('已合并 PR 列表格式无效')
        const upstreamNumber = merged[0]?.number
        if (!upstreamNumber)
          return failed(`上游分支 ${run.stackBranch} 已删除且未合并，无法堆叠交付`)
        const base = await readDefaultBranch({ repo, command })
        await git('check-ref-format', `refs/heads/${base}`)
        await remoteGit('fetch', '--no-tags', '--', remoteUrl, `refs/heads/${base}`)
        const newBase = await git('rev-parse', '--verify', 'FETCH_HEAD^{commit}')
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(newBase)) throw new Error('默认分支提交无效')
        const dir = await mkdtemp(join(landing, 'rebase-'))
        await git('clone', '--template=', '--no-hardlinks', '--no-checkout', '--', landing, dir)
        const rebaseGit = (...args: string[]) =>
          command(['git', ...args], {
            cwd: dir,
            env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
            quietStderr: true,
          })
        await rebaseGit('switch', '-C', branch, oldTip)
        try {
          await rebaseGit(
            '-c',
            'user.name=workling',
            '-c',
            'user.email=workling@localhost',
            'rebase',
            // 重试时生成同一 tip，才能识别上一轮已推送的变基结果。
            '--committer-date-is-author-date',
            '--onto',
            newBase,
            baseRef,
            branch,
          )
        } catch (error) {
          const files = await rebaseGit('diff', '--name-only', '--diff-filter=U', '-z')
          if (!files) throw error
          await rebaseGit('rebase', '--abort')
          return failed(
            `上游 #${upstreamNumber} 已合并，变基到 ${base} 冲突：${redactSecrets(files.split('\0').filter(Boolean).join('、'), secrets)}`,
          )
        }
        await git('fetch', '--no-tags', '--', dir, `+${ref}:${ref}`)
        tip = await git('rev-parse', '--verify', `${ref}^{commit}`)
        restacked = { baseRef: newBase, baseBranch: base, upstreamNumber }
      }
    }

    if (plan)
      for (const path of plan.docs) {
        try {
          await git('cat-file', '-e', `${tip}:${path}`)
        } catch {
          return failed(`plan.json 列出的文档不存在：${redactSecrets(path, secrets)}`)
        }
      }

    const remote = (await remoteGit('ls-remote', '--heads', '--', remoteUrl, ref))
      .split('\n')
      .find((line) => line.endsWith(`\t${ref}`))
    let pushed = false
    if (remote !== `${tip}\t${ref}`) {
      if (
        remote &&
        remote !== `${baseRef}\t${ref}` &&
        !(restacked && remote === `${oldTip}\t${ref}`)
      )
        return failed('远端分支已更新，与本次基点不一致')
      await remoteGit(
        'push',
        ...(restacked ? [`--force-with-lease=${ref}:${remote?.split('\t')[0] ?? ''}`] : []),
        '--',
        remoteUrl,
        `${tip}:${ref}`,
      )
      pushed = true
    }
    if (plan) return await publishPlan(plan, branch)
    if (!pr) return failed('缺少 out/pr-body.md')

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
    const prBody = neutralizeMentions(redactSecrets(pr.body, secrets))
    const prepared = preparePr(prBody, issue.number, pr.outcome)
    const { partial } = prepared
    if (existing && !pushed && !restacked)
      return {
        status: 'done',
        prUrl: existing.url,
        prState: 'open',
        commits,
        head: tip,
        partial,
        created: false,
      }

    const deliveryBody = (body: string) =>
      restacked
        ? `${body}\n\n上游 #${restacked.upstreamNumber} 已在本任务运行期间合并，已自动变基到 ${restacked.baseBranch}。`
        : run.stackBranch
          ? `${body}\n\n堆叠于 #${run.stackBranch.match(/^workling\/(\d+)-/)?.[1] ?? '?'} 的分支 \`${run.stackBranch}\`，请先审阅并合并上游 PR。`
          : body

    const prFields = async () => {
      const title =
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
      return {
        body: prepared.body,
        title: partial && !title.startsWith('[部分完成]') ? `[部分完成] ${title}` : title,
      }
    }
    let prUrl: string
    if (existing) {
      prUrl = existing.url
      try {
        const { title, body } = await prFields()
        await gh(
          [
            'pr',
            'edit',
            prUrl,
            ...(restacked ? ['--base', restacked.baseBranch] : []),
            '--title',
            title,
            '--body-file',
            '-',
          ],
          withAiNotice(restacked ? deliveryBody(body) : body),
        )
      } catch (error) {
        if (restacked) throw error
        warn('更新 PR')
      }
      if (pr.outcome === 'completed' && existing.isDraft) {
        try {
          await gh(['pr', 'ready', prUrl])
        } catch {
          warn('将 PR 标记为可审查')
        }
      }
    } else {
      const base =
        restacked?.baseBranch ?? run.stackBranch ?? (await readDefaultBranch({ repo, command }))
      if (!base) throw new Error('无法读取仓库默认分支')
      const { title, body } = await prFields()
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
        withAiNotice(deliveryBody(body)),
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
    return {
      status: 'done',
      prUrl,
      prState: 'open',
      commits,
      head: tip,
      partial,
      created: !existing,
      ...(restacked ? { restacked: { baseRef: restacked.baseRef } } : {}),
    }
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
