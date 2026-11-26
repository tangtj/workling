import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { feedback, issues, repos, runs } from '../db/schema.ts'
import { canPlan, readSubIssues } from '../issue/chain.ts'
import { ghEnv } from '../platform/github.ts'
import { markComment } from './comment.ts'
import { errorMessage } from '../runtime/errors.ts'
import type { Command } from '../runtime/types.ts'
import { syncProgress } from './progress.ts'

type Row = typeof feedback.$inferSelect
type Candidate = { issue: typeof issues.$inferSelect; run: typeof runs.$inferSelect }

export function selectBatch({ issue, run }: Candidate, rows: Row[]): Row[] {
  const number = prNumberOf(issue.prUrl)
  return rows.filter(
    (row) =>
      row.status === 'observed' &&
      row.createdAt > run.startedAt &&
      (row.prNumber === null || (number !== 0 && row.prNumber === number)),
  )
}

export function prNumberOf(prUrl: string | null): number {
  return Number(/\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl ?? '')?.[1] ?? 0)
}

/** 只有 CHANGES_REQUESTED review 的批次算自动返工；带指令前缀的评论属于显式触发。 */
export function isAutoBatch(rows: Row[]): boolean {
  return rows.length > 0 && rows.every((row) => row.source === 'review')
}

/** 当前 PR 上已发生的自动返工轮数：反馈全在该 PR、且没有显式指令的返工运行。 */
export function countAutoRounds(prNumber: number, rows: Row[], reworkRunIds: Set<number>): number {
  const byRun = new Map<number, Row[]>()
  for (const row of rows) {
    if (row.runId === null || !reworkRunIds.has(row.runId)) continue
    if (row.status !== 'included' && row.status !== 'replied') continue
    byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row])
  }
  let rounds = 0
  for (const group of byRun.values())
    if (
      group.every((row) => row.prNumber === prNumber) &&
      !group.some((row) => row.source !== 'review' && row.isCommand)
    )
      rounds++
  return rounds
}

export async function queueRework({
  db,
  command,
  log,
  signal,
  reworkLimit = 3,
}: {
  db: WorklingDatabase
  command: Command
  log: (message: string) => void
  signal: AbortSignal
  reworkLimit?: number
}) {
  const candidates = db
    .select({ issue: issues, run: runs, repo: repos })
    .from(issues)
    .innerJoin(runs, eq(issues.lastRunId, runs.id))
    .innerJoin(repos, eq(issues.repoId, repos.id))
    .where(
      and(
        eq(repos.enabled, true),
        eq(repos.platform, 'github'),
        inArray(issues.status, ['done', 'failed']),
        or(isNull(issues.prState), eq(issues.prState, 'open')),
      ),
    )
    .all()
  for (const candidate of candidates) {
    if (signal.aborted) break
    const { issue, repo } = candidate
    const rows = db.select().from(feedback).where(eq(feedback.issueId, issue.id)).all()
    const batch = selectBatch(candidate, rows)
    if (!batch.length) continue
    if (candidate.run.kind === 'plan') {
      let subs
      try {
        subs = await readSubIssues({ repo, number: issue.number, command, signal })
      } catch (error) {
        if (!signal.aborted)
          log(`${repo.ref} #${issue.number} 读取子 Issue 失败：${errorMessage(error)}`)
        continue
      }
      if (!canPlan(subs)) {
        db.update(feedback)
          .set({ status: 'ignored' })
          .where(
            inArray(
              feedback.id,
              batch.map((row) => row.id),
            ),
          )
          .run()
        try {
          await command(
            ['gh', 'issue', 'comment', String(issue.number), '-R', repo.path, '--body-file', '-'],
            {
              env: ghEnv(repo.token, repo.host),
              input: markComment(
                'workling：已经拆出子 Issue，不再重新拆解。要调整请直接编辑子 Issue；要整体重来，请把子 Issue 全部关闭为「不计划」，再评论 `/workling <说明>`。',
              ),
              signal,
            },
          )
        } catch (error) {
          if (!signal.aborted)
            log(`${repo.ref} #${issue.number} 发送拆解说明失败：${errorMessage(error)}`)
        }
        continue
      }
    }
    const prNumber = prNumberOf(issue.prUrl)
    if (issue.prState === 'open' && prNumber && isAutoBatch(batch)) {
      const reworkRunIds = new Set(
        db
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.issueId, issue.id), eq(runs.kind, 'rework')))
          .all()
          .map((run) => run.id),
      )
      const rounds = countAutoRounds(prNumber, rows, reworkRunIds)
      if (rounds >= reworkLimit) {
        const capped = db
          .update(feedback)
          .set({ status: 'capped' })
          .where(
            and(
              inArray(
                feedback.id,
                batch.map((item) => item.id),
              ),
              eq(feedback.status, 'observed'),
            ),
          )
          .returning()
          .all()
        if (!capped.length) continue
        log(`${repo.ref} #${issue.number} 自动返工已达上限（${rounds}/${reworkLimit}），不再入队`)
        const body =
          reworkLimit === 0
            ? '已关闭自动返工（WORKLING_REWORK_LIMIT=0），这次 Request changes 不会自动处理。'
            : `本 PR 已自动返工 ${rounds} 轮，达到上限（WORKLING_REWORK_LIMIT=${reworkLimit}），这次 Request changes 不再自动处理。`
        try {
          await command(['gh', 'pr', 'comment', issue.prUrl!, '--body-file', '-'], {
            env: ghEnv(repo.token, repo.host),
            input: markComment(`workling：${body}需要继续时请评论 \`/workling <说明>\`。`),
            signal,
          })
        } catch (error) {
          if (!signal.aborted)
            log(`${repo.ref} #${issue.number} 发送返工上限评论失败：${errorMessage(error)}`)
        }
        continue
      }
    }
    const updated = db.transaction((tx) => {
      const row = tx
        .update(issues)
        .set({ status: 'queued', updatedAt: new Date() })
        .where(and(eq(issues.id, issue.id), eq(issues.status, issue.status)))
        .returning()
        .get()
      if (!row) return false
      tx.update(feedback)
        .set({ status: 'pending' })
        .where(
          and(
            inArray(
              feedback.id,
              batch.map((item) => item.id),
            ),
            eq(feedback.status, 'observed'),
          ),
        )
        .run()
      return true
    })
    if (!updated) continue
    log(`${repo.ref} #${issue.number} 收到 ${batch.length} 条反馈，重新入队`)
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
          `workling:${issue.status}`,
          '--add-label',
          'workling:queued',
        ],
        { env: ghEnv(repo.token, repo.host), signal },
      )
    } catch (error) {
      if (!signal.aborted) log(`${repo.ref} #${issue.number} 更新标签失败：${errorMessage(error)}`)
    }
    if (issue.progressCommentId !== null)
      await syncProgress({ db, repo, issue, command, log, signal })
  }
}
