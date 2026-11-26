import { and, eq, ne } from 'drizzle-orm'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import type { WorklingDatabase } from '../db/index.ts'
import { issues, repos, runs } from '../db/schema.ts'
import { ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
import { formatDuration, formatPrLink, markComment, runKindLabel } from './comment.ts'
import { redactSecrets } from './secret-scan.ts'

type Issue = typeof issues.$inferSelect
type ProgressIssue = Pick<Issue, 'status' | 'prState' | 'prUrl'>
type Run = Pick<
  typeof runs.$inferSelect,
  'id' | 'kind' | 'startedAt' | 'endedAt' | 'error' | 'outcome'
>

const outcomes = {
  completed: '✅ 完成',
  partial: '🟡 部分完成',
  answered: '💬 答复',
  planned: '🧩 完成',
}

function statusLabel(issue: ProgressIssue, rounds: readonly Run[]): string {
  switch (issue.status) {
    case 'queued':
      return '⏳ 排队中'
    case 'running':
      return `▶️ 第 ${rounds.length} 轮进行中`
    case 'failed':
      return '❌ 未完成，等待处理'
    case 'canceled':
      return '已取消'
    case 'done':
      if (issue.prState === 'open') return '👀 等待评审与合并'
      if (issue.prState === 'merged') return '✅ 已合并'
      if (issue.prState === 'closed') return 'PR 已关闭'
      return rounds.at(-1)?.outcome === 'planned' ? '🧩 拆解完成，等待确认' : '💬 已答复'
  }
}

function roundResult(run: Run): string {
  if (!run.endedAt) return '▶️ 进行中'
  if (run.error === '已取消') return '已取消'
  if (run.error) return '❌ 未完成'
  return (run.outcome && outcomes[run.outcome]) || '已结束'
}

export function renderProgress(issue: ProgressIssue, runs: readonly Run[]): string {
  const rounds = runs.filter((run) => run.kind !== 'review').sort((a, b) => a.id - b.id)
  const omitted = Math.max(0, rounds.length - 20)
  const table = ['| 轮次 | 类型 | 结果 | 用时 | 开始 |', '| ---- | ---- | ---- | ---- | ---- |']
  for (const [i, run] of rounds.slice(omitted).entries()) {
    const started = run.startedAt.toISOString().slice(5, 16).replace('T', ' ')
    const duration = run.endedAt
      ? formatDuration(run.startedAt, run.endedAt).slice('用时 '.length)
      : ''
    table.push(
      `| ${omitted + i + 1} | ${runKindLabel[run.kind]} | ${roundResult(run)} | ${duration} | ${started} UTC |`,
    )
  }
  return [
    `### 进度 · ${statusLabel(issue, rounds)}`,
    ...(issue.prUrl ? [formatPrLink(issue.prUrl)] : []),
    ...(omitted ? [`（更早的 ${omitted} 轮已省略）`] : []),
    table.join('\n'),
    '这条评论由 workling 随进度更新；每一轮的详情见下方对应的评论。',
  ].join('\n\n')
}

const commentSchema = Type.Object({
  id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
})

export async function syncProgress({
  db,
  repo,
  issue,
  command,
  log,
  signal,
}: {
  db: WorklingDatabase
  repo: typeof repos.$inferSelect
  issue: Pick<Issue, 'id' | 'number'>
  command: Command
  log: (message: string) => void
  signal?: AbortSignal
}): Promise<void> {
  if (repo.platform !== 'github') return
  try {
    const current = db.select().from(issues).where(eq(issues.id, issue.id)).get()
    if (!current) return
    const rounds = db
      .select()
      .from(runs)
      .where(and(eq(runs.issueId, issue.id), ne(runs.kind, 'review')))
      .all()
    const options = {
      env: ghEnv(repo.token, repo.host),
      input: JSON.stringify({ body: markComment(renderProgress(current, rounds)) }),
      signal,
    }
    const saveId = (id: number | null) =>
      db.update(issues).set({ progressCommentId: id }).where(eq(issues.id, issue.id)).run()
    const comments = `repos/${repo.path}/issues`
    if (current.progressCommentId !== null) {
      try {
        await command(
          [
            'gh',
            'api',
            '--method',
            'PATCH',
            `${comments}/comments/${current.progressCommentId}`,
            '--input',
            '-',
          ],
          options,
        )
        return
      } catch (error) {
        if (!/\bHTTP 404\b/.test(errorMessage(error))) throw error
        saveId(null)
      }
    }
    const response = await command(
      ['gh', 'api', '--method', 'POST', `${comments}/${current.number}/comments`, '--input', '-'],
      options,
    )
    const parsed: unknown = JSON.parse(response)
    if (!Value.Check(commentSchema, parsed)) throw new Error('创建进度评论的响应格式无效')
    saveId(parsed.id)
  } catch (error) {
    log(
      `${repo.ref} #${issue.number} 更新进度评论失败：${redactSecrets(errorMessage(error), [repo.token])}`,
    )
  }
}
