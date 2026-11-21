import { and, eq } from 'drizzle-orm'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { machineLogin, readPiSettings } from '../config/pi.ts'
import type { WorklingDatabase } from '../db/index.ts'
import { feedback, feedbackCursors, issues, repos, trustedUsers } from '../db/schema.ts'
import { ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
export function matchCommandPrefix(body: string, login: string): string | null {
  const trimmed = body.trimStart()
  const match = /^(\/workling|@[^\s]+)(?=\s|$)/i.exec(trimmed)
  if (!match || !['/workling', `@${login.toLowerCase()}`].includes(match[1]!.toLowerCase()))
    return null
  return trimmed.slice(match[0].length).trim()
}

// Mask excluded Markdown regions while preserving offsets and line boundaries.
function visibleText(body: string): string {
  let fence: { char: string; length: number } | null = null
  let comment = false
  let result = ''
  const blank = (text: string) => text.replace(/[^\n]/g, ' ')
  for (let i = 0; i < body.length;) {
    if (i === 0 || body[i - 1] === '\n') {
      const end = body.indexOf('\n', i)
      const lineEnd = end < 0 ? body.length : end + 1
      const line = body.slice(i, lineEnd)
      if (fence) {
        const close = /^ {0,3}(`+|~+)\s*$/.exec(line.trimEnd())
        if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null
        result += blank(line)
        i = lineEnd
        continue
      }
      if (!comment) {
        const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
        if (open) {
          fence = { char: open[1]![0]!, length: open[1]!.length }
          result += blank(line)
          i = lineEnd
          continue
        }
        if (/^ {0,3}>/.test(line)) {
          result += blank(line)
          i = lineEnd
          continue
        }
      }
    }
    if (comment) {
      if (body.startsWith('-->', i)) {
        result += '   '
        i += 3
        comment = false
      } else {
        result += blank(body[i]!)
        i++
      }
    } else if (body.startsWith('<!--', i)) {
      comment = true
    } else if (body[i] === '`') {
      const open = /^`+/.exec(body.slice(i))![0]
      const runs = /`+/g
      runs.lastIndex = i + open.length
      let close: RegExpExecArray | null
      while ((close = runs.exec(body)) && close[0].length !== open.length) {}
      if (close) {
        const end = close.index + close[0].length
        result += blank(body.slice(i, end))
        i = end
      } else {
        result += open
        i += open.length
      }
    } else {
      result += body[i]!
      i++
    }
  }
  return result
}

export function parseCommand(
  body: string,
  token: string,
  machine: string | null,
): string | null | undefined {
  const prefix = matchCommandPrefix(body, token)
  if (prefix !== null) return prefix || null
  if (!machine) return undefined
  const visible = visibleText(body)
  const lower = visible.toLowerCase()
  const mention = `@${machine.toLowerCase()}`
  let from = 0
  while (true) {
    const index = lower.indexOf(mention, from)
    if (index < 0) return undefined
    const before = visible[index - 1] ?? ''
    const after = visible[index + mention.length] ?? ''
    if (!/[a-z\d_./@-]/i.test(before) && !/[a-z\d_-]/i.test(after)) {
      if (!body.slice(0, index).trim() && (!after || /\s/.test(after)))
        return body.slice(index + mention.length).trim() || null
      return body.trim() || null
    }
    from = index + mention.length
  }
}

const user = Type.Object({ id: Type.Integer(), login: Type.String(), type: Type.String() })
const common = {
  id: Type.Integer(),
  user,
  body: Type.Union([Type.String(), Type.Null()]),
  html_url: Type.String(),
}
const comment = Type.Object({
  ...common,
  created_at: Type.String(),
  updated_at: Type.String(),
  issue_url: Type.Optional(Type.String()),
  pull_request_url: Type.Optional(Type.String()),
  pull_request_review_id: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  path: Type.Optional(Type.String()),
  line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  original_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
})
const review = Type.Object({
  ...common,
  state: Type.String(),
  submitted_at: Type.Union([Type.String(), Type.Null()]),
})
const permission = Type.Object({ permission: Type.String() })
type Trust = typeof feedback.$inferSelect.trust
export type FeedbackState = {
  accounts: Map<number, { token: string; login: string }>
  permissions: Map<string, { value: boolean; expires: number }>
}

export async function judgeTrust({
  db,
  repo,
  user,
  body,
  command,
  env,
  signal,
  permissions,
  machine = null,
}: {
  db: WorklingDatabase
  repo: typeof repos.$inferSelect
  user: { id: number; login: string; type: string }
  body: string
  command: Command
  env: ReturnType<typeof ghEnv>
  signal: AbortSignal
  permissions: FeedbackState['permissions']
  machine?: string | null
}): Promise<Trust> {
  if (body.includes('<!-- workling -->')) return 'self'
  if (machine && user.login.toLowerCase() === machine.toLowerCase()) return 'self'
  if (user.type === 'Bot') return 'bot'
  if (
    db
      .select()
      .from(trustedUsers)
      .where(and(eq(trustedUsers.repoId, repo.id), eq(trustedUsers.userId, String(user.id))))
      .get()
  )
    return 'allowlist'
  const key = `${repo.id}:${user.id}`
  let cached = permissions.get(key)
  if (!cached || cached.expires <= Date.now()) {
    let allowed = false
    try {
      const response: unknown = JSON.parse(
        await command(
          [
            'gh',
            'api',
            `repos/${repo.path}/collaborators/${encodeURIComponent(user.login)}/permission`,
            '--include',
          ],
          { env, signal },
        ).then((output) => output.replace(/^HTTP\/[^\n]*\n(?:[^\n]*\n)*?\r?\n/, '')),
      )
      if (!Value.Check(permission, response)) throw new Error('权限格式无效')
      allowed = ['admin', 'maintain', 'write'].includes(response.permission)
    } catch (error) {
      if (!/\b404\b/.test(errorMessage(error))) throw error
    }
    cached = { value: allowed, expires: Date.now() + 600_000 }
    permissions.set(key, cached)
  }
  return cached.value ? 'write' : 'untrusted'
}

export function classifyCommand(
  body: string,
  trust: Trust,
  login: string,
  reviewState: string | null,
  machine: string | null = null,
) {
  if (trust !== 'allowlist' && trust !== 'write') return { isCommand: false, instruction: null }
  if (reviewState === 'CHANGES_REQUESTED')
    return { isCommand: true, instruction: body.trim() || null }
  const rest = parseCommand(body, login, machine)
  if (rest === undefined) return { isCommand: false, instruction: null }
  return { isCommand: true, instruction: rest || null }
}

export async function observeFeedback({
  db,
  command,
  log,
  signal,
  state,
}: {
  db: WorklingDatabase
  command: Command
  log: (message: string) => void
  signal: AbortSignal
  state: FeedbackState
}) {
  const machine = machineLogin(readPiSettings(db).gitEmail)
  const repositories = db
    .select()
    .from(repos)
    .where(and(eq(repos.enabled, true), eq(repos.platform, 'github')))
    .all()
  for (const repo of repositories) {
    if (signal.aborted) break
    const records = db.select().from(issues).where(eq(issues.repoId, repo.id)).all()
    if (!records.length) continue
    try {
      const env = ghEnv(repo.token, repo.host)
      const now = new Date()
      const cursors = new Map(
        db
          .select()
          .from(feedbackCursors)
          .where(eq(feedbackCursors.repoId, repo.id))
          .all()
          .map((c) => [c.kind, c]),
      )
      for (const kind of ['issue_comments', 'review_comments'] as const) {
        if (!cursors.has(kind))
          db.insert(feedbackCursors)
            .values({ repoId: repo.id, kind, cursor: now, startedAt: now })
            .run()
      }
      const pr = (url: string | null) =>
        Number(/\/pull\/(\d+)(?:[/?#]|$)/.exec(url ?? '')?.[1] ?? 0)
      const account = state.accounts.get(repo.id)
      let login = account?.token === repo.token ? account.login : ''
      const getLogin = async () => {
        if (!login) {
          login = (await command(['gh', 'api', 'user', '--jq', '.login'], { env, signal })).trim()
          if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(login)) throw new Error('账号格式无效')
          state.accounts.set(repo.id, { token: repo.token, login })
        }
        return login
      }
      const save = async (
        item: {
          id: number
          user: { id: number; login: string; type: string }
          body: string | null
          html_url: string
        },
        issueId: number,
        source: typeof feedback.$inferSelect.source,
        prNumber: number | null,
        createdAt: string,
        updatedAt: string,
        path: string | null,
        line: number | null,
        reviewState: string | null,
        reviewId: string | null = null,
      ) => {
        const created = new Date(createdAt),
          updated = new Date(updatedAt)
        if (!Number.isFinite(created.getTime()) || !Number.isFinite(updated.getTime()))
          throw new Error('反馈时间无效')
        const externalId = String(item.id)
        const old = db
          .select()
          .from(feedback)
          .where(
            and(
              eq(feedback.repoId, repo.id),
              eq(feedback.source, source),
              eq(feedback.externalId, externalId),
            ),
          )
          .get()
        if (old && (!['ignored', 'observed'].includes(old.status) || old.updatedAt >= updated))
          return
        const body = (item.body ?? '').slice(0, 65536)
        const trust =
          (machine && item.user.login.toLowerCase() === machine.toLowerCase()
            ? 'self'
            : old?.trust) ??
          (await judgeTrust({
            db,
            repo,
            user: item.user,
            body: item.body ?? '',
            command,
            env,
            signal,
            permissions: state.permissions,
            machine,
          }))
        const result = classifyCommand(
          body,
          trust,
          trust === 'allowlist' || trust === 'write' ? await getLogin() : '',
          reviewState,
          machine,
        )
        const values = {
          body,
          ...result,
          status: result.isCommand ? ('observed' as const) : ('ignored' as const),
          updatedAt: updated,
          reviewState,
          reviewId,
        }
        if (old) db.update(feedback).set(values).where(eq(feedback.id, old.id)).run()
        else
          db.insert(feedback)
            .values({
              ...values,
              repoId: repo.id,
              issueId,
              prNumber,
              source,
              externalId,
              authorId: String(item.user.id),
              authorLogin: item.user.login,
              trust,
              path,
              line,
              url: item.html_url,
              createdAt: created,
              seenAt: now,
            })
            .run()
      }
      for (const kind of ['issue_comments', 'review_comments'] as const) {
        const cursor = cursors.get(kind)
        if (!cursor) continue
        const since = new Date(cursor.cursor.getTime() - 300_000).toISOString()
        const endpoint = kind === 'issue_comments' ? 'issues/comments' : 'pulls/comments'
        const pages: unknown = JSON.parse(
          await command(
            [
              'gh',
              'api',
              `repos/${repo.path}/${endpoint}?since=${since}&sort=updated&direction=asc&per_page=100`,
              '--paginate',
              '--slurp',
            ],
            { env, signal },
          ),
        )
        if (!Value.Check(Type.Array(Type.Array(comment)), pages)) throw new Error('评论格式无效')
        for (const item of pages.flat()) {
          if (
            !Number.isFinite(Date.parse(item.created_at)) ||
            !Number.isFinite(Date.parse(item.updated_at)) ||
            !(kind === 'issue_comments' ? item.issue_url : item.pull_request_url)
          )
            throw new Error('评论时间或归属无效')
          if (!(Date.parse(item.created_at) > cursor.startedAt.getTime())) continue
          const number = Number(
            /\/(\d+)$/.exec(
              (kind === 'issue_comments' ? item.issue_url : item.pull_request_url) ?? '',
            )?.[1] ?? 0,
          )
          const issue =
            kind === 'issue_comments'
              ? (records.find((r) => r.number === number) ??
                records.find((r) => pr(r.prUrl) === number))
              : records.find((r) => pr(r.prUrl) === number)
          if (!issue || !number) continue
          const source =
            kind === 'review_comments'
              ? 'review_comment'
              : issue.number === number
                ? 'issue_comment'
                : 'pr_comment'
          await save(
            item,
            issue.id,
            source,
            source === 'issue_comment' ? null : number,
            item.created_at,
            item.updated_at,
            item.path ?? null,
            item.line ?? item.original_line ?? null,
            null,
            item.pull_request_review_id == null ? null : String(item.pull_request_review_id),
          )
        }
      }
      const started = cursors.get('issue_comments')?.startedAt
      if (started)
        for (const issue of records.filter((r) => r.prState === 'open' && pr(r.prUrl))) {
          const number = pr(issue.prUrl)
          const pages: unknown = JSON.parse(
            await command(
              [
                'gh',
                'api',
                `repos/${repo.path}/pulls/${number}/reviews?per_page=100`,
                '--paginate',
                '--slurp',
              ],
              { env, signal },
            ),
          )
          if (!Value.Check(Type.Array(Type.Array(review)), pages))
            throw new Error('Review 格式无效')
          for (const item of pages.flat()) {
            if (
              item.state !== 'PENDING' &&
              (!item.submitted_at || !Number.isFinite(Date.parse(item.submitted_at)))
            )
              throw new Error('Review 时间无效')
            if (
              item.state === 'PENDING' ||
              !item.submitted_at ||
              !(Date.parse(item.submitted_at) > started.getTime())
            )
              continue
            await save(
              item,
              issue.id,
              'review',
              number,
              item.submitted_at,
              item.submitted_at,
              null,
              null,
              item.state,
            )
          }
        }
      for (const kind of cursors.keys())
        db.update(feedbackCursors)
          .set({ cursor: now })
          .where(and(eq(feedbackCursors.repoId, repo.id), eq(feedbackCursors.kind, kind)))
          .run()
    } catch (error) {
      if (!signal.aborted) log(`${repo.ref} 观察反馈失败：${errorMessage(error)}`)
    }
  }
}
