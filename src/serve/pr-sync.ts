import { desc, eq, isNotNull, and, ne } from 'drizzle-orm'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import type { WorklingDatabase } from '../db/index.ts'
import { issues, repos, runs } from '../db/schema.ts'
import { defaultBranch as readDefaultBranch, ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
import { markComment, neutralizeMentions } from './comment.ts'
import { mirrorPath } from './mirror.ts'
import { syncProgress } from './progress.ts'
import { setStatusLabel } from './status-label.ts'

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
    const base = await readDefaultBranch({ repo, command, signal })
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

const closedSchema = Type.Array(
  Type.Object({ number: Type.Integer(), stateReason: Type.Union([Type.String(), Type.Null()]) }),
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
      const changed = new Map<number, typeof issues.$inferSelect>()
      for (const issue of rows) {
        if (signal.aborted) return
        if (issue.status === 'running' || issue.status === 'queued') continue
        const pr = best.get(issue.number)
        if (!pr) continue
        const prState = pr.state.toLowerCase() as NonNullable<typeof issue.prState>
        const complete =
          prState === 'merged' && (issue.status === 'failed' || issue.status === 'canceled')
        const statusChanged = issue.prState !== prState || complete
        if (issue.prUrl !== pr.url || statusChanged)
          db.update(issues)
            .set({
              prUrl: pr.url,
              prState,
              ...(complete ? { status: 'done' as const, updatedAt: new Date() } : {}),
            })
            .where(eq(issues.id, issue.id))
            .run()
        if (statusChanged) changed.set(issue.id, issue)
        if (complete) {
          log(`${repo.ref} #${issue.number} PR 已合并，状态由 ${issue.status} 改为 done`)
          try {
            await setStatusLabel({ repo, number: issue.number, target: 'done', command, signal })
          } catch (error) {
            if (signal.aborted) return
            log(`${repo.ref} #${issue.number} 更新标签失败：${errorMessage(error)}`)
          }
        }
        if (issue.prState === 'open' && prState === 'merged') {
          const upstreamRun = db
            .select()
            .from(runs)
            .where(and(eq(runs.issueId, issue.id), ne(runs.kind, 'review')))
            .orderBy(desc(runs.id))
            .get()
          if (!upstreamRun?.branch) continue
          for (const downstream of rows) {
            if (downstream.prState !== 'open' || downstream.id === issue.id) continue
            const run = db
              .select()
              .from(runs)
              .where(
                and(
                  eq(runs.issueId, downstream.id),
                  ne(runs.kind, 'review'),
                  isNotNull(runs.stackBranch),
                ),
              )
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
      try {
        const output = await command(
          [
            'gh',
            'issue',
            'list',
            '-R',
            repo.path,
            '--state',
            'closed',
            '--label',
            'workling:failed',
            '--json',
            'number,stateReason',
            '--limit',
            '100',
          ],
          { env: ghEnv(repo.token, repo.host), signal },
        )
        const parsed: unknown = JSON.parse(output)
        if (!Value.Check(closedSchema, parsed)) throw new Error('已关闭 Issue 列表格式无效')
        const closed = new Set(parsed.map((issue) => issue.number))
        for (const issue of rows) {
          if (signal.aborted) return
          if (issue.status !== 'failed' || !closed.has(issue.number)) continue
          const current = db.select().from(issues).where(eq(issues.id, issue.id)).get()
          if (
            !current ||
            current.status !== 'failed' ||
            (current.prState !== null && current.prState !== 'closed')
          )
            continue
          db.update(issues)
            .set({ status: 'canceled', updatedAt: new Date() })
            .where(eq(issues.id, issue.id))
            .run()
          changed.set(current.id, current)
          log(`${repo.ref} #${issue.number} Issue 已关闭，状态由 failed 改为 canceled`)
          try {
            await setStatusLabel({ repo, number: issue.number, target: null, command, signal })
          } catch (error) {
            if (signal.aborted) return
            log(`${repo.ref} #${issue.number} 更新标签失败：${errorMessage(error)}`)
          }
        }
      } catch (error) {
        if (signal.aborted) return
        log(`${repo.ref} 已关闭 Issue 同步失败：${errorMessage(error)}`)
      }
      for (const issue of changed.values()) {
        if (signal.aborted) return
        // 已结束的旧 Issue 不补建评论。已有 outcome 的新交付可以重试之前失败的创建。
        const tracked =
          issue.progressCommentId !== null ||
          db
            .select({ id: runs.id })
            .from(runs)
            .where(
              and(eq(runs.issueId, issue.id), ne(runs.kind, 'review'), isNotNull(runs.outcome)),
            )
            .get()
        if (tracked) await syncProgress({ db, repo, issue, command, log, signal })
      }
    } catch (error) {
      if (signal.aborted) return
      log(`${repo.ref} PR 同步失败：${errorMessage(error)}`)
    }
  }
}
