import { desc, eq, isNotNull, and } from 'drizzle-orm'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import type { WorklingDatabase } from '../db/index.ts'
import { issues, repos, runs } from '../db/schema.ts'
import { ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
import { markComment, neutralizeMentions } from './comment.ts'
import { mirrorPath } from './mirror.ts'

async function rebaseDownstream({
  db,
  command,
  log,
  signal,
  workspace,
  repo,
  upstream,
  downstream,
  run,
}: {
  db: WorklingDatabase
  command: Command
  log: (message: string) => void
  signal: AbortSignal
  workspace: string
  repo: typeof repos.$inferSelect
  upstream: typeof issues.$inferSelect
  downstream: typeof issues.$inferSelect
  run: typeof runs.$inferSelect
}): Promise<void> {
  const env = { ...ghEnv(repo.token, repo.host), GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }
  const gh = (args: string[], input?: string) => command(['gh', ...args], { env, input, signal })
  const comment = (kind: 'issue' | 'pr', target: string, body: string) =>
    gh(
      [kind, 'comment', target, '-R', repo.path, '--body-file', '-'],
      markComment(neutralizeMentions(body)),
    )
  const warn = (step: string) => log(`${repo.ref} #${downstream.number} ${step}失败`)
  if (downstream.status === 'running') {
    log(`${repo.ref} #${downstream.number} 正在运行，跳过自动变基`)
    try {
      await comment(
        'issue',
        String(downstream.number),
        `workling：上游 #${upstream.number} 已合并，当前任务正在运行，请手动将下游 PR 变基到默认分支并修改 base。`,
      )
    } catch {
      warn('发送跳过提示')
    }
    return
  }
  let dir: string | undefined
  try {
    if (
      !run.branch?.startsWith(`workling/${downstream.number}-`) ||
      !run.baseRef ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(run.baseRef) ||
      !downstream.prUrl
    )
      throw new Error('下游分支、基点或 PR 缺失')
    const base = await gh(['api', `repos/${repo.path}`, '--jq', '.default_branch'])
    if (!base || base.startsWith('-')) throw new Error('默认分支无效')
    const parent = join(workspace, 'rebase')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    dir = await mkdtemp(join(parent, 'task-'))
    await command(
      ['git', 'clone', '--no-hardlinks', '--no-checkout', '--', mirrorPath(workspace, repo), dir],
      { signal, quietStderr: true },
    )
    const git = (...args: string[]) =>
      command(['git', ...args], { cwd: dir, env, signal, quietStderr: true })
    const remoteGit = (...args: string[]) =>
      git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args)
    await git('check-ref-format', `refs/heads/${base}`)
    await git('check-ref-format', `refs/heads/${run.branch}`)
    await git('remote', 'set-url', 'origin', `https://${repo.host}/${repo.path}.git`)
    await remoteGit('fetch', 'origin')
    const tip = await git('rev-parse', '--verify', `refs/remotes/origin/${run.branch}^{commit}`)
    const baseTip = await git('rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`)
    if (
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tip) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseTip)
    )
      throw new Error('远端提交无效')
    await git('switch', '-C', run.branch, tip)
    try {
      await git(
        '-c',
        'user.name=workling',
        '-c',
        'user.email=workling@localhost',
        'rebase',
        '--onto',
        `origin/${base}`,
        run.baseRef,
        run.branch,
      )
    } catch (error) {
      const files = await git('diff', '--name-only', '--diff-filter=U')
      await git('rebase', '--abort')
      if (!files) throw error
      await comment(
        'issue',
        String(downstream.number),
        `workling：上游 #${upstream.number} 已合并，自动变基到 ${base} 时冲突（${files.split('\n').join('、')}）。评论 \`/workling 变基到 ${base} 并解决冲突\` 可交给 workling 处理。`,
      )
      return
    }
    await remoteGit(
      'push',
      `--force-with-lease=refs/heads/${run.branch}:${tip}`,
      'origin',
      `refs/heads/${run.branch}:refs/heads/${run.branch}`,
    )
    await gh(['pr', 'edit', downstream.prUrl, '-R', repo.path, '--base', base])
    db.update(runs).set({ stackBranch: null, baseRef: baseTip }).where(eq(runs.id, run.id)).run()
    await comment(
      'pr',
      downstream.prUrl,
      `workling：上游 #${upstream.number} 已合并，已将本 PR 变基到 ${base}。`,
    )
  } catch {
    if (!signal.aborted) warn('自动变基')
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true })
  }
}

const schema = Type.Array(
  Type.Object({
    number: Type.Number(),
    url: Type.String(),
    headRefName: Type.String(),
    state: Type.Union([Type.Literal('OPEN'), Type.Literal('MERGED'), Type.Literal('CLOSED')]),
    updatedAt: Type.String({ format: 'date-time' }),
  }),
)

export async function syncPullRequests({
  db,
  command,
  log,
  signal,
  workspace = '.',
}: {
  db: WorklingDatabase
  command: Command
  log: (message: string) => void
  signal: AbortSignal
  workspace?: string
}): Promise<void> {
  for (const repo of db.select().from(repos).all()) {
    if (signal.aborted) return
    if (!repo.enabled || repo.platform !== 'github') continue
    const rows = db.select().from(issues).where(eq(issues.repoId, repo.id)).all()
    if (!rows.length) continue
    try {
      const output = await command(
        [
          'gh',
          'pr',
          'list',
          '-R',
          repo.path,
          '--state',
          'all',
          '--search',
          'head:workling/',
          '--json',
          'number,url,headRefName,state,updatedAt',
          '--limit',
          '100',
        ],
        { env: ghEnv(repo.token, repo.host), signal },
      )
      if (signal.aborted) return
      const parsed: unknown = JSON.parse(output)
      if (!Value.Check(schema, parsed)) throw new Error('PR 列表格式无效')
      const best = new Map<number, (typeof parsed)[number]>()
      for (const pr of parsed) {
        const match = /^workling\/(\d+)-/.exec(pr.headRefName)
        if (!match) continue
        const number = Number(match[1])
        const previous = best.get(number)
        if (
          !previous ||
          (pr.state === 'OPEN' && previous.state !== 'OPEN') ||
          ((pr.state === 'OPEN') === (previous.state === 'OPEN') &&
            Date.parse(pr.updatedAt) > Date.parse(previous.updatedAt))
        )
          best.set(number, pr)
      }
      for (const issue of rows) {
        if (signal.aborted) return
        if (issue.status === 'running' || issue.status === 'queued') continue
        const pr = best.get(issue.number)
        if (!pr) continue
        const prState = pr.state.toLowerCase() as NonNullable<typeof issue.prState>
        if (issue.prUrl !== pr.url || issue.prState !== prState)
          db.update(issues).set({ prUrl: pr.url, prState }).where(eq(issues.id, issue.id)).run()
        if (issue.prState === 'open' && prState === 'merged') {
          const upstreamRun = db
            .select()
            .from(runs)
            .where(eq(runs.issueId, issue.id))
            .orderBy(desc(runs.id))
            .get()
          if (!upstreamRun?.branch) continue
          for (const downstream of rows) {
            if (downstream.prState !== 'open' || downstream.id === issue.id) continue
            const run = db
              .select()
              .from(runs)
              .where(and(eq(runs.issueId, downstream.id), isNotNull(runs.stackBranch)))
              .orderBy(desc(runs.id))
              .get()
            if (run?.stackBranch !== upstreamRun.branch) continue
            await rebaseDownstream({
              db,
              command,
              log,
              signal,
              workspace,
              repo,
              upstream: issue,
              downstream,
              run,
            })
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return
      log(`${repo.ref} PR 同步失败：${errorMessage(error)}`)
    }
  }
}
