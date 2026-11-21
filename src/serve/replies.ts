import { and, eq, inArray } from 'drizzle-orm'
import { missingOutput, readReplies, truncateComment, type Reply } from '../contract/out.ts'
import type { WorklingDatabase } from '../db/index.ts'
import { feedback } from '../db/schema.ts'
import { ghEnv } from '../platform/github.ts'
import type { Command } from '../runtime/types.ts'
import { markComment, neutralizeMentions } from './comment.ts'
import { runOutDir } from './land.ts'
import { redactSecrets } from './secret-scan.ts'

type Row = typeof feedback.$inferSelect

export const feedbackSourceNames: Record<Row['source'], string> = {
  issue_comment: 'Issue 评论',
  pr_comment: 'PR 评论',
  review_comment: '行内评论',
  review: 'Review',
}

const missingReply = '（本轮未单独说明，见 Issue 评论中的总结。）'

type Target =
  | { kind: 'thread'; row: Row; body: string }
  | { kind: 'pr' | 'issue'; rows: Row[]; replies: Map<number, string> }

/** 行内评论回到原线程；其余按反馈出现的位置汇总，没有 PR 时并入 Issue。 */
export function planReplies(rows: Row[], replies: Reply[], prUrl: string | null): Target[] {
  const ids = new Set(rows.map((row) => row.id))
  const byId = new Map<number, string>()
  for (const reply of replies)
    if (ids.has(reply.feedbackId) && !byId.has(reply.feedbackId))
      byId.set(reply.feedbackId, reply.body)
  const targets: Target[] = []
  const pr: Row[] = []
  const issue: Row[] = []
  for (const row of rows) {
    const body = byId.get(row.id)
    if (row.source === 'review_comment' && body !== undefined && row.prNumber !== null)
      targets.push({ kind: 'thread', row, body })
    else if (row.source === 'issue_comment' || !prUrl) issue.push(row)
    else pr.push(row)
  }
  if (pr.length) targets.push({ kind: 'pr', rows: pr, replies: byId })
  if (issue.length) targets.push({ kind: 'issue', rows: issue, replies: byId })
  return targets
}

function summary(rows: Row[], replies: Map<number, string>): string {
  const sections = rows.map((row) =>
    [
      `### F${row.id} · ${feedbackSourceNames[row.source]}${row.reviewState ? `（${row.reviewState}）` : ''} · @${row.authorLogin}`,
      row.url,
      '',
      replies.get(row.id) ?? missingReply,
    ].join('\n'),
  )
  return ['workling：反馈处理说明', ...sections].join('\n\n')
}

export async function publishReplies({
  db,
  repo,
  issue,
  runId,
  taskDir,
  prUrl,
  command,
  llmApiKey,
  log,
}: {
  db: WorklingDatabase
  repo: { host: string; path: string; token: string }
  issue: { number: number }
  runId: number
  taskDir: string
  prUrl: string | null
  command: Command
  llmApiKey: string | null
  log: (message: string) => void
}): Promise<void> {
  const rows = db
    .select()
    .from(feedback)
    .where(and(eq(feedback.runId, runId), eq(feedback.status, 'included')))
    .orderBy(feedback.createdAt, feedback.id)
    .all()
  if (!rows.length) return
  let replies: Reply[] = []
  try {
    replies = await readReplies(await runOutDir(taskDir))
  } catch (error) {
    if (!missingOutput(error)) log(`${repo.path} #${issue.number} 读取反馈回复失败`)
  }
  const env = ghEnv(repo.token, repo.host)
  const render = (text: string) =>
    markComment(
      truncateComment(neutralizeMentions(redactSecrets(text, [repo.token, llmApiKey ?? '']))),
    )
  const markReplied = (ids: number[]) =>
    db
      .update(feedback)
      .set({ status: 'replied' })
      .where(and(inArray(feedback.id, ids), eq(feedback.status, 'included')))
      .run()

  for (const target of planReplies(rows, replies, prUrl)) {
    const included = target.kind === 'thread' ? [target.row] : target.rows
    try {
      if (target.kind === 'thread')
        await command(
          [
            'gh',
            'api',
            '--method',
            'POST',
            `repos/${repo.path}/pulls/${target.row.prNumber}/comments/${target.row.externalId}/replies`,
            '--input',
            '-',
          ],
          {
            env,
            input: JSON.stringify({ body: render(`workling：${target.body}`) }),
            quietStderr: true,
          },
        )
      else if (target.kind === 'pr')
        await command(['gh', 'pr', 'comment', prUrl!, '--body-file', '-'], {
          env,
          input: render(summary(target.rows, target.replies)),
          quietStderr: true,
        })
      else
        await command(
          ['gh', 'issue', 'comment', String(issue.number), '-R', repo.path, '--body-file', '-'],
          { env, input: render(summary(target.rows, target.replies)), quietStderr: true },
        )
      markReplied(included.map((row) => row.id))
    } catch {
      log(
        `${repo.path} #${issue.number} 回复反馈 ${included.map((row) => `F${row.id}`).join('、')} 失败`,
      )
    }
  }
}
