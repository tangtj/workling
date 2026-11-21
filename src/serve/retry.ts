import { and, eq } from 'drizzle-orm'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import type { WorklingDatabase } from '../db/index.ts'
import { issues, repos, runs } from '../db/schema.ts'
import { ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'

const commentsSchema = Type.Array(
  Type.Array(
    Type.Object({
      id: Type.Integer(),
      issue_url: Type.String(),
      user: Type.Object({ login: Type.String() }),
      body: Type.String(),
      created_at: Type.String(),
      html_url: Type.String(),
    }),
  ),
)

export type RetryState = {
  accounts: Map<number, { token: string; login: string }>
  triggers: Map<number, string>
}

/** 正文 trimStart 后以 /workling 或 @<login> 开头（不区分大小写，其后为空白或结尾）时返回前缀之后 trim 的文字，否则返回 null。 */
export function matchCommandPrefix(body: string, login: string): string | null {
  const trimmed = body.trimStart()
  const match = /^(\/workling|@[^\s]+)(?=\s|$)/i.exec(trimmed)
  if (!match || !['/workling', `@${login.toLowerCase()}`].includes(match[1]!.toLowerCase()))
    return null
  return trimmed.slice(match[0].length).trim()
}

export async function retryOnCommand({
  db,
  command,
  log,
  signal,
  state = { accounts: new Map(), triggers: new Map() },
}: {
  db: WorklingDatabase
  command: Command
  log: (message: string) => void
  signal: AbortSignal
  state?: RetryState
}) {
  const repositories = db
    .select()
    .from(repos)
    .where(and(eq(repos.enabled, true), eq(repos.platform, 'github')))
    .orderBy(repos.id)
    .all()
  for (const repo of repositories) {
    if (signal.aborted) break
    const failed = db
      .select({ issue: issues, run: runs })
      .from(issues)
      .innerJoin(runs, eq(issues.lastRunId, runs.id))
      .where(and(eq(issues.repoId, repo.id), eq(issues.status, 'failed')))
      .all()
    if (!failed.length) continue
    try {
      const env = ghEnv(repo.token, repo.host)
      let account = state.accounts.get(repo.id)
      if (!account || account.token !== repo.token) {
        const login = (
          await command(['gh', 'api', 'user', '--jq', '.login'], { env, signal })
        ).trim()
        if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(login)) throw new Error('账号格式无效')
        account = { token: repo.token, login }
        state.accounts.set(repo.id, account)
      }
      const since = new Date(
        Math.min(...failed.map(({ run }) => run.startedAt.getTime())),
      ).toISOString()
      const output = await command(
        [
          'gh',
          'api',
          `repos/${repo.path}/issues/comments?since=${since}&sort=created&direction=asc&per_page=100`,
          '--paginate',
          '--slurp',
        ],
        { env, signal },
      )
      const pages: unknown = JSON.parse(output)
      if (!Value.Check(commentsSchema, pages)) throw new Error('Issue 评论格式无效')
      const matches = new Map<number, string>()
      for (const comment of pages.flat()) {
        const number = /\/(\d+)$/.exec(comment.issue_url)?.[1]
        const entry = failed.find(({ issue }) => issue.number === Number(number))
        if (!entry || !(Date.parse(comment.created_at) > entry.run.startedAt.getTime())) continue
        if (comment.user.login.toLowerCase() !== account.login.toLowerCase()) continue
        if (matchCommandPrefix(comment.body, account.login) === null) continue
        matches.set(entry.issue.id, comment.html_url)
      }
      for (const { issue } of failed) {
        if (signal.aborted) break
        const url = matches.get(issue.id)
        if (!url) continue
        const updated = db
          .update(issues)
          .set({ status: 'queued', updatedAt: new Date() })
          .where(and(eq(issues.id, issue.id), eq(issues.status, 'failed')))
          .returning()
          .get()
        if (!updated) continue
        state.triggers.set(issue.id, url)
        log(`${repo.ref} #${issue.number} 收到指令评论，重新入队`)
        try {
          await command(
            [
              'gh',
              'issue',
              'edit',
              String(issue.number),
              '-R',
              repo.path,
              '--remove-label',
              'workling:failed',
              '--add-label',
              'workling:queued',
            ],
            { env, signal },
          )
        } catch (error) {
          if (!signal.aborted)
            log(`${repo.ref} #${issue.number} 更新标签失败：${errorMessage(error)}`)
        }
      }
    } catch (error) {
      if (!signal.aborted) log(`${repo.ref} 检查指令评论失败：${errorMessage(error)}`)
    }
  }
}
