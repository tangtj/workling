import { markComment, neutralizeMentions } from './comment.ts'
import { type ExecutorSettings } from '../config/executor.ts'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  maxCommentLength,
  readExecution,
  readPlan,
  truncateComment,
  type Execution,
} from '../contract/out.ts'
import { removeSecrets } from '../contract/secrets.ts'
import { type WorklingDatabase } from '../db/index.ts'
import { feedback, issues as issueStates, repos, reviews, runs } from '../db/schema.ts'
import { createExecutor, type Executor } from '../executor/index.ts'
import { readParent, readSubIssues } from '../issue/chain.ts'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { ghEnv } from '../platform/github.ts'
import { assertTaskDir, readResult } from '../contract/result.ts'
import { type PiSettings } from '../config/pi.ts'
import type { Command } from '../runtime/types.ts'
import { extractSummary, reportExcerpt } from '../contract/report.ts'
import type { Settings } from '../config/env.ts'

import { errorMessage } from '../runtime/errors.ts'
import { landRun, publishIssueResult, readRunIssueComment, runOutDir } from './land.ts'
import { mirrorPath } from './mirror.ts'
import { setStatusLabel } from './status-label.ts'
import { publishReplies } from './replies.ts'
import { redactSecrets } from './secret-scan.ts'
type Log = (message: string) => void

const reconcileFailureTimeoutMs = 30 * 60_000
const reconcileFailures = new Map<number, Date>()

export function clearReconcileFailures(): void {
  reconcileFailures.clear()
}

export function recoverOrphanFeedback(db: WorklingDatabase): void {
  const orphanIds = db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(issueStates, eq(runs.issueId, issueStates.id))
    .where(
      and(
        eq(issueStates.status, 'queued'),
        ne(runs.kind, 'review'),
        isNull(runs.endedAt),
        isNull(runs.pid),
        isNull(runs.container),
      ),
    )
    .all()
    .map((row) => row.id)
  if (orphanIds.length)
    db.update(feedback)
      .set({ status: 'pending', runId: null })
      .where(and(eq(feedback.status, 'included'), inArray(feedback.runId, orphanIds)))
      .run()
}

export async function cleanTaskDirs(
  db: WorklingDatabase,
  workspace: string,
  repo: typeof repos.$inferSelect,
  issue: typeof issueStates.$inferSelect,
  keepRuns: number,
) {
  const parent = join(workspace, 'tasks')
  let names: string[]
  try {
    names = await readdir(parent)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  const prefix = `${repo.path.replace('/', '-')}-${issue.number}-`
  const old = names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .slice(keepRuns)
  const records = db.select().from(runs).all()
  const active = new Set(records.filter((run) => !run.endedAt).map((run) => run.taskDir))
  for (const name of old) {
    const dir = assertTaskDir(workspace, join(parent, name))
    if (active.has(dir)) continue
    if (records.some((run) => run.issueId === issue.id && run.taskDir === dir && run.endedAt))
      await rm(dir, { recursive: true, force: true })
  }
}

export type ReconcileOptions = {
  db: WorklingDatabase
  command: Command
  log: Log
  settings: Settings
  pi: PiSettings
  executorSettings: ExecutorSettings
  now?: () => Date
  executor?: Executor
}

export async function reconcile({
  db,
  command,
  log,
  settings,
  pi,
  executorSettings,
  now = () => new Date(),
  executor = createExecutor(executorSettings, command, log),
}: ReconcileOptions): Promise<void> {
  const rows = db
    .select({ issue: issueStates, repo: repos, run: runs })
    .from(issueStates)
    .innerJoin(repos, eq(issueStates.repoId, repos.id))
    .leftJoin(runs, eq(issueStates.lastRunId, runs.id))
    .where(eq(issueStates.status, 'running'))
    .all()
  const runningIds = new Set(rows.map(({ issue }) => issue.id))
  for (const id of reconcileFailures.keys()) if (!runningIds.has(id)) reconcileFailures.delete(id)
  for (const { issue, repo, run } of rows) {
    const current = now()
    let status: 'done' | 'failed' | 'canceled' = 'failed'
    let error: string | null = null
    let endedAt = current
    let exitCode: number | null = null
    let prUrl: string | null | undefined
    let prState: typeof issue.prState | undefined
    let readyToLand = false
    let answer:
      | {
          taskDir: string
          planned?: Extract<Awaited<ReturnType<typeof landRun>>, { status: 'planned' }>
        }
      | undefined
    let delivery:
      | {
          taskDir: string
          landed: Extract<Awaited<ReturnType<typeof landRun>>, { status: 'done' }>
        }
      | undefined
    let sustainedFailure = false
    let terminalSaved = false
    try {
      if (!run?.taskDir) error = '缺少任务目录'
      else {
        const result = await readResult(run.taskDir)
        if (result === 'invalid') error = 'result.json 无效'
        else if (result) {
          const finishedAt = new Date(result.finishedAt)
          if (!Number.isNaN(finishedAt.getTime())) endedAt = finishedAt
          exitCode = result.exitCode
          if (run.error === '已取消') {
            status = 'canceled'
            error = '已取消'
          } else if (result.exitCode === 0 && !result.error) {
            if (!run.branch) error = '缺少分支记录'
            else readyToLand = true
          } else {
            error =
              run.error ??
              result.error ??
              (result.signal ? `信号 ${result.signal}` : `退出码 ${result.exitCode}`)
          }
        } else {
          const handle = { ...run, taskDir: run.taskDir }
          const state = await executor.status(handle)
          if (state.running) {
            if (run.error === '超时' || run.error === '已取消')
              await executor.signal(handle, 'SIGKILL')
            else if (current.getTime() - run.startedAt.getTime() > settings.timeout * 60_000) {
              db.update(runs).set({ error: '超时' }).where(eq(runs.id, run.id)).run()
              await executor.signal(handle, 'SIGTERM')
            }
            continue
          }
          status = run.error === '已取消' ? 'canceled' : 'failed'
          error = run.error ?? (state.oom ? '内存不足（OOM）' : '进程丢失')
        }
      }
      if (run?.taskDir) {
        const taskDir = assertTaskDir(settings.workspace, run.taskDir)
        try {
          await executor.finish({ ...run, taskDir })
        } finally {
          await removeSecrets(taskDir).catch(() => {
            log(`${repo.ref} #${issue.number} 删除任务密钥失败`)
          })
        }
        if (readyToLand) {
          // 落地遇到暂时错误时保留 running，下轮重试；此时 worker 已不再需要密钥。
          const landed = await landRun({
            db,
            workspace: settings.workspace,
            repo,
            issue,
            run: { ...run, taskDir },
            mirror: mirrorPath(settings.workspace, repo),
            command,
            log,
            llmApiKey: pi.llmApiKey,
          })
          if (landed.status === 'done') {
            ;({ status, prUrl, prState } = landed)
            delivery = { taskDir, landed }
          } else if (landed.status === 'planned' || landed.status === 'answered') {
            status = 'done'
            if (landed.status === 'planned') {
              prUrl = prState = null
              answer = { taskDir, planned: landed }
            } else answer = { taskDir }
          } else error = landed.error
        }
      }
      await finish()
    } catch (caught) {
      const message = redactSecrets(errorMessage(caught), [repo.token, pi.llmApiKey ?? ''])
      log(`${repo.ref} #${issue.number} 对账失败：${message}`)
      if (terminalSaved) {
        reconcileFailures.delete(issue.id)
        continue
      }
      const failedAt = now()
      const firstFailure = reconcileFailures.get(issue.id)
      if (!firstFailure) reconcileFailures.set(issue.id, failedAt)
      else if (failedAt.getTime() - firstFailure.getTime() > reconcileFailureTimeoutMs) {
        status = 'failed'
        error = message
        endedAt = failedAt
        delivery = undefined
        answer = undefined
        prUrl = undefined
        prState = undefined
        sustainedFailure = true
        try {
          await finish()
        } catch (finishError) {
          log(
            `${repo.ref} #${issue.number} 对账收尾失败：${redactSecrets(errorMessage(finishError), [repo.token, pi.llmApiKey ?? ''])}`,
          )
        }
        if (terminalSaved) reconcileFailures.delete(issue.id)
      }
    }
    async function finish() {
      const summary = run?.taskDir
        ? await extractSummary(run.taskDir, [repo.token, pi.llmApiKey ?? ''])
        : { summary: null, reportResult: null, logTail: null }
      const secrets = [repo.token, pi.llmApiKey ?? '']
      let execution: Execution = { executor: null, assessment: null }
      if (run?.taskDir && (run.kind === 'implement' || run.kind === 'rework')) {
        try {
          execution = await readExecution(await runOutDir(run.taskDir))
        } catch {
          // 任务目录已清理或不是普通目录时不记录。
        }
      }
      if (answer?.planned) {
        try {
          const plan = await readPlan(await runOutDir(answer.taskDir))
          summary.summary = redactSecrets(plan.summary, secrets)
        } catch {
          log(`${repo.ref} #${issue.number} 读取拆解摘要失败`)
        }
      }
      db.transaction((tx) => {
        tx.update(issueStates)
          .set({ status, updatedAt: current, prUrl, prState })
          .where(eq(issueStates.id, issue.id))
          .run()
        if (run)
          tx.update(runs)
            .set({
              endedAt,
              exitCode,
              error,
              ...summary,
              executor: execution.executor,
              difficulty: execution.assessment?.difficulty ?? null,
              clarity: execution.assessment?.clarity ?? null,
              assessmentNote: execution.assessment
                ? redactSecrets(execution.assessment.reason, secrets)
                : null,
              ...(delivery?.landed.restacked
                ? { stackBranch: null, baseRef: delivery.landed.restacked.baseRef }
                : {}),
            })
            .where(eq(runs.id, run.id))
            .run()
        if (delivery && run?.branch && repo.platform === 'github' && repo.host === 'github.com') {
          const currentRepo = tx
            .select({ level: repos.reviewLevel })
            .from(repos)
            .where(eq(repos.id, repo.id))
            .get()
          if (currentRepo?.level === 'shadow') {
            const { prUrl, head, partial } = delivery.landed
            tx.insert(reviews)
              .values({
                repoId: repo.id,
                issueId: issue.id,
                deliveryRunId: run.id,
                prUrl,
                branch: run.branch,
                headSha: head,
                partial,
                status: 'queued',
                createdAt: current,
              })
              .onConflictDoNothing({ target: reviews.deliveryRunId })
              .run()
          }
        }
      })
      terminalSaved = true
      // 库是执行状态的事实来源；GitHub 同步失败不能回滚终态。
      const sync = async (args: string[], input?: string) => {
        try {
          await command(args, { env: ghEnv(repo.token, repo.host), input })
        } catch (error) {
          log(`${repo.ref} #${issue.number} 更新 GitHub 失败：${errorMessage(error)}`)
        }
      }
      if (repo.platform === 'github') {
        try {
          await setStatusLabel({
            repo,
            number: issue.number,
            target: status === 'done' ? 'done' : 'failed',
            command,
          })
        } catch (error) {
          log(`${repo.ref} #${issue.number} 更新 GitHub 失败：${errorMessage(error)}`)
        }
        try {
          const signal = new AbortController().signal
          const parent = await readParent({ repo, number: issue.number, command, signal })
          if (parent) {
            const subs = await readSubIssues({ repo, number: parent.number, command, signal })
            const complete = subs
              .filter(
                (sub) =>
                  sub.sameRepo && !(sub.state === 'closed' && sub.stateReason === 'not_planned'),
              )
              .every((sub) => {
                if (sub.state === 'closed' && sub.stateReason === 'completed') return true
                const row = db
                  .select()
                  .from(issueStates)
                  .where(and(eq(issueStates.repoId, repo.id), eq(issueStates.number, sub.number)))
                  .get()
                if (row?.prState === 'merged') return true
                const last = row?.lastRunId
                  ? db.select().from(runs).where(eq(runs.id, row.lastRunId)).get()
                  : undefined
                return row?.status === 'done' && !!last?.reportResult?.startsWith('完成')
              })
            const target =
              status !== 'done'
                ? 'workling:failed'
                : complete
                  ? 'workling:done'
                  : 'workling:running'
            const value: unknown = JSON.parse(
              await command(
                ['gh', 'issue', 'view', String(parent.number), '-R', repo.path, '--json', 'labels'],
                { env: ghEnv(repo.token, repo.host) },
              ),
            )
            const schema = Type.Object({ labels: Type.Array(Type.Object({ name: Type.String() })) })
            if (!Value.Check(schema, value)) throw new Error('主 Issue 标签格式无效')
            const labels = value.labels.map((label) => label.name)
            const others = [
              'workling:queued',
              'workling:running',
              'workling:done',
              'workling:failed',
            ].filter((label) => label !== target && labels.includes(label))
            if (!labels.includes(target) || others.length)
              await command(
                [
                  'gh',
                  'issue',
                  'edit',
                  String(parent.number),
                  '-R',
                  repo.path,
                  ...others.flatMap((label) => ['--remove-label', label]),
                  ...(!labels.includes(target) ? ['--add-label', target] : []),
                ],
                { env: ghEnv(repo.token, repo.host) },
              )
          }
        } catch (error) {
          log(`${repo.ref} #${issue.number} 汇总主 Issue 失败：${errorMessage(error)}`)
        }
        if (delivery) {
          await publishIssueResult({
            ...delivery,
            repo,
            issue,
            command,
            llmApiKey: pi.llmApiKey,
            log,
          })
          await publishReplies({
            db,
            repo,
            issue,
            runId: run!.id,
            taskDir: delivery.taskDir,
            prUrl: delivery.landed.prUrl,
            command,
            llmApiKey: pi.llmApiKey,
            log,
          })
        } else if (answer) {
          const explanation = await readRunIssueComment(answer.taskDir, (step) =>
            log(`${repo.ref} #${issue.number} ${step}失败`),
          )
          const clean = (body: string) => neutralizeMentions(redactSecrets(body, secrets))
          let body: string
          if (answer.planned) {
            const list = answer.planned.children.map(
              ({ number, title }, i) => `${i + 1}. #${number} ${clean(title.replace(/\s+/g, ' '))}`,
            )
            const docs = answer.planned.branch
              ? `\n\n设计文档：<https://${repo.host}/${repo.path}/tree/${answer.planned.branch}>`
              : ''
            const suffix = `\n\n### 子 Issue\n\n${list.join('\n')}${docs}\n\n审阅文档与子 Issue 后，给本 Issue 重新打上 \`workling:ready\`，子 Issue 会按上面的顺序执行。要调整可以直接编辑子 Issue；要整体重新拆解，请把子 Issue 全部关闭为「不计划」，再评论 \`/workling <说明>\`。`
            const intro = clean(
              ['workling：已完成拆解。', summary.summary, explanation.trim()]
                .filter(Boolean)
                .join('\n\n'),
            )
            const limit = maxCommentLength - suffix.length
            const truncated = '\n\n（已截断）'
            body =
              (intro.length > limit
                ? intro.slice(0, limit - truncated.length).replace(/[\uD800-\uDBFF]$/, '') +
                  truncated
                : intro) + suffix
          } else
            body = truncateComment(
              clean(`workling：已答复。\n\n${explanation.trim() || '（Pi 未写说明）'}`),
            )
          await sync(
            ['gh', 'issue', 'comment', String(issue.number), '-R', repo.path, '--body-file', '-'],
            markComment(body),
          )
          await publishReplies({
            db,
            repo,
            issue,
            runId: run!.id,
            taskDir: answer.taskDir,
            prUrl: !answer.planned && issue.prState === 'open' ? issue.prUrl : null,
            command,
            llmApiKey: pi.llmApiKey,
            log,
          })
        } else if (status !== 'done') {
          let report = ''
          let explanation = ''
          if (run?.taskDir) {
            const warn = (step: string) => log(`${repo.ref} #${issue.number} ${step}失败`)
            try {
              const taskDir = assertTaskDir(settings.workspace, run.taskDir)
              explanation = await readRunIssueComment(taskDir, warn)
              report = reportExcerpt(
                redactSecrets(await readFile(join(taskDir, 'report.md'), 'utf8'), secrets),
              )
                .split(/\r?\n/)
                .map((line) => `> ${line}`)
                .join('\n')
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                log(`${repo.ref} #${issue.number} 读取报告失败：${errorMessage(error)}`)
            }
          }
          const minutes = run
            ? Math.ceil((endedAt.getTime() - run.startedAt.getTime()) / 60_000)
            : 0
          const header = sustainedFailure
            ? `workling：对账持续失败（${error}），已停止重试。`
            : `workling：执行未完成（${error}）。`
          const body = `${header}\n\n- 机器：${settings.worker}\n- 耗时：${minutes} 分钟\n- 任务目录：${run?.taskDir ?? ''}\n\n${report ? `${report}\n\n` : ''}重新打上 workling:ready，或评论 \`/workling <补充说明>\` 即可重试。${explanation ? `\n\n### Pi 的说明\n\n${explanation}` : ''}`
          await sync(
            ['gh', 'issue', 'comment', String(issue.number), '-R', repo.path, '--body-file', '-'],
            markComment(neutralizeMentions(redactSecrets(body, secrets))),
          )
        }
      }
      if (status === 'done' && run?.taskDir)
        await rm(join(assertTaskDir(settings.workspace, run.taskDir), 'repo'), {
          recursive: true,
          force: true,
        })
      await cleanTaskDirs(db, settings.workspace, repo, issue, settings.keepRuns)
      log(`${repo.ref} #${issue.number} 已标记为 ${status}${error ? `：${error}` : ''}`)
      reconcileFailures.delete(issue.id)
    }
  }
}
