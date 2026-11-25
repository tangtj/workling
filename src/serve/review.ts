import { and, eq, gt, isNull } from 'drizzle-orm'
import { join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { missingOutput, readReview, type Review } from '../contract/out.ts'
import { extractSummary } from '../contract/report.ts'
import { assertTaskDir, readResult } from '../contract/result.ts'
import { removeSecrets, writeLlmSecrets } from '../contract/secrets.ts'
import { CONTRACT_VERSION, writeSpec } from '../contract/spec.ts'
import type { WorklingDatabase } from '../db/index.ts'
import { issues, repos, reviews, runs } from '../db/schema.ts'
import { createExecutor, workerEnv, type RunHandle } from '../executor/index.ts'
import { docBranch } from '../issue/branch.ts'
import { readIssue } from '../issue/read.ts'
import { parseIssueRef } from '../issue/reference.ts'
import { defaultBranch, ghEnv } from '../platform/github.ts'
import { errorMessage } from '../runtime/errors.ts'
import { writeRunContext } from './context.ts'
import { runOutDir } from './land.ts'
import { cloneCheckout, type LaunchOptions } from './launch.ts'
import { syncMirror } from './mirror.ts'
import { cleanTaskDirs, type ReconcileOptions } from './reconcile.ts'
import { redactSecrets } from './secret-scan.ts'
import { countRunningTasks } from './slots.ts'
import { createTaskDir } from './task-dir.ts'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const prSchema = Type.Object({
  baseRefName: Type.String({ minLength: 1 }),
  headRefOid: Type.String({ pattern: oid.source }),
})
const launchFailures = new WeakMap<WorklingDatabase, Map<number, number>>()

export async function launchReviews({
  db,
  command,
  log,
  settings,
  pi,
  executorSettings,
  signal,
  now = () => new Date(),
  executor = createExecutor(executorSettings, command, log),
}: LaunchOptions): Promise<void> {
  if (executorSettings.sandbox === 'docker' && !pi.llmBaseUrl) return
  let slots = executorSettings.concurrency - countRunningTasks(db)
  if (slots <= 0) return
  const rows = db
    .select({ review: reviews, issue: issues, repo: repos })
    .from(reviews)
    .innerJoin(issues, eq(reviews.issueId, issues.id))
    .innerJoin(repos, eq(reviews.repoId, repos.id))
    .where(
      and(
        eq(reviews.status, 'queued'),
        eq(repos.enabled, true),
        eq(repos.platform, 'github'),
        eq(repos.host, 'github.com'),
      ),
    )
    .orderBy(reviews.id)
    .all()
  let failures = launchFailures.get(db)
  if (!failures) {
    failures = new Map()
    launchFailures.set(db, failures)
  }
  for (const { review, issue, repo } of rows) {
    if (slots <= 0 || signal.aborted) break
    const secrets = [repo.token, pi.llmApiKey ?? '']
    const prefix = `${repo.ref} #${issue.number}`
    const { headSha, branch, prUrl } = review
    let runId: number | undefined
    let taskDir: string | undefined
    let handle: RunHandle | undefined
    const skip = (error: string) => {
      db.update(reviews)
        .set({ status: 'skipped', error, endedAt: now() })
        .where(eq(reviews.id, review.id))
        .run()
      failures.delete(review.id)
    }

    try {
      if (repo.reviewLevel === 'off') {
        skip('评审已关闭')
        continue
      }
      const newer = db
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.issueId, issue.id), gt(reviews.id, review.id)))
        .get()
      if (newer) {
        skip('已有更新的交付')
        continue
      }
      if (issue.status === 'queued' || issue.status === 'running') {
        skip('Issue 正在执行，等待下一次交付')
        continue
      }
      if (!oid.test(headSha)) throw new Error('评审提交无效')
      const mirror = await syncMirror({ workspace: settings.workspace, repo, command, signal })
      const git = (...args: string[]) =>
        command(['git', ...args], { cwd: mirror, signal, quietStderr: true })
      try {
        await git('cat-file', '-e', `${headSha}^{commit}`)
      } catch {
        signal.throwIfAborted()
        skip(`提交 ${headSha.slice(0, 7)} 已不在仓库中`)
        continue
      }
      const env = ghEnv(repo.token, repo.host)
      const pr: unknown = JSON.parse(
        await command(['gh', 'pr', 'view', prUrl, '--json', 'baseRefName,headRefOid'], {
          env,
          signal,
          quietStderr: true,
        }),
      )
      if (!Value.Check(prSchema, pr)) throw new Error('PR 评审范围格式无效')
      if (pr.headRefOid !== headSha) {
        skip('PR 已有新的提交')
        continue
      }
      let start = pr.baseRefName
      const baseBranchRef = `refs/heads/${start}`
      await git('check-ref-format', baseBranchRef)
      const heads = await git('for-each-ref', '--format=%(refname)', baseBranchRef)
      if (!heads.split('\n').includes(baseBranchRef))
        start = await defaultBranch({ repo, command, signal })
      let baseRef: string
      try {
        const base = `refs/heads/${start}`
        await git('check-ref-format', base)
        baseRef = await git('merge-base', base, headSha)
        if (!oid.test(baseRef)) throw new Error('评审基点无效')
      } catch {
        signal.throwIfAborted()
        skip('无法确定评审范围')
        continue
      }

      const startedAt = now()
      const issueRef = `github:${repo.path}#${issue.number}`
      const ref = parseIssueRef(issueRef)
      taskDir = await createTaskDir(settings.workspace, ref, startedAt, 'review')
      const model = pi.reviewModel ?? pi.model
      const effort = pi.reviewEffort ?? 'high'
      // 在写入密钥、拉起 worker 前关联运行，启动恢复可以识别只有记录而没有句柄的评审。
      const record = db.transaction((tx) => {
        const run = tx
          .insert(runs)
          .values({
            issueId: issue.id,
            kind: 'review',
            worker: settings.worker,
            taskDir,
            startedAt,
            baseRef,
          })
          .returning()
          .get()
        tx.update(reviews)
          .set({ status: 'running', runId: run.id, model, effort })
          .where(eq(reviews.id, review.id))
          .run()
        return run
      })
      runId = record.id
      const options = await cloneCheckout({ taskDir, mirror, pi, command, signal })
      await command(['git', 'switch', '-c', branch, headSha], options)
      const taskCommand: typeof command = (args, options) => command(args, { ...options, signal })
      const { title, body } = await readIssue({
        ref,
        dir: join(taskDir, 'input'),
        command: taskCommand,
        env,
      })
      const doc = docBranch(body)
      const specRepo = { baseRef, branch, ...(doc && 'name' in doc ? { docBranch: doc.name } : {}) }
      await writeRunContext({
        db,
        taskDir,
        repo,
        issue,
        runId,
        kind: 'review',
        prUrl,
        checkout: { ...specRepo, start },
        command: taskCommand,
        secrets,
        log,
      })
      await writeSpec(taskDir, {
        contract: CONTRACT_VERSION,
        kind: 'review',
        issue: { ref: issueRef, title },
        repo: specRepo,
        model: { codex: model, effort, ...(pi.piModel !== null ? { pi: pi.piModel } : {}) },
        git: { name: pi.gitName, email: pi.gitEmail },
      })
      if (pi.llmBaseUrl !== null) {
        await writeLlmSecrets(taskDir, {
          baseUrl: pi.llmBaseUrl,
          apiKey: pi.llmApiKey!,
          api: pi.llmApi,
        })
      }
      signal.throwIfAborted()
      const started = await executor.start({
        runId,
        ref: issueRef,
        taskDir,
        env: { ...workerEnv(process.env), WORKLING_WORKSPACE: settings.workspace },
      })
      handle = { taskDir, pid: started.pid ?? null, container: started.container ?? null }
      db.update(runs)
        .set({ pid: handle.pid, container: handle.container })
        .where(eq(runs.id, runId))
        .run()
      slots--
      failures.delete(review.id)
    } catch (caught) {
      const endedAt = now()
      const error = redactSecrets(`拉起失败：${errorMessage(caught)}`, secrets)
      if (handle) {
        // 进程已启动但未能保存句柄，先停止它，避免重试后同时运行两个评审。
        try {
          if ((await executor.status(handle)).running) await executor.signal(handle, 'SIGKILL')
          await executor.finish(handle)
        } catch (cleanupError) {
          log(`${prefix} 清理评审执行器失败：${redactSecrets(errorMessage(cleanupError), secrets)}`)
        }
      }
      if (taskDir) await removeSecrets(taskDir).catch(() => log(`${prefix} 删除任务密钥失败`))
      const attempts = (failures.get(review.id) ?? 0) + Number(!signal.aborted)
      db.transaction((tx) => {
        if (runId !== undefined)
          tx.update(runs).set({ endedAt, error }).where(eq(runs.id, runId)).run()
        tx.update(reviews)
          .set(
            attempts >= 3
              ? { status: 'failed', error, endedAt }
              : { status: 'queued', runId: null, model: null, effort: null },
          )
          .where(eq(reviews.id, review.id))
          .run()
      })
      if (attempts >= 3) failures.delete(review.id)
      else failures.set(review.id, attempts)
      log(`${prefix} 评审${error}`)
    }
  }
}

export async function reconcileReviews({
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
    .select({ review: reviews, repo: repos, issue: issues, run: runs })
    .from(reviews)
    .innerJoin(repos, eq(reviews.repoId, repos.id))
    .innerJoin(issues, eq(reviews.issueId, issues.id))
    .leftJoin(runs, and(eq(reviews.runId, runs.id), eq(runs.kind, 'review')))
    .where(eq(reviews.status, 'running'))
    .all()
  for (const { review, repo, issue, run } of rows) {
    const prefix = `${repo.ref} #${issue.number}`
    const secrets = [repo.token, pi.llmApiKey ?? '']
    const redact = (text: string) => redactSecrets(text, secrets)
    let endedAt = now()
    let exitCode: number | null = null
    let logTail: string | null = null
    let error: string | null = null
    let output: Review | undefined
    try {
      if (!run?.taskDir) error = '缺少任务目录'
      else {
        const taskDir = assertTaskDir(settings.workspace, run.taskDir)
        const handle = { ...run, taskDir }
        const result = await readResult(taskDir)
        if (result === 'invalid') error = 'result.json 无效'
        else if (result) {
          const finishedAt = new Date(result.finishedAt)
          if (!Number.isNaN(finishedAt.getTime())) endedAt = finishedAt
          exitCode = result.exitCode
          if (exitCode !== 0 || result.error !== undefined)
            error =
              run.error ??
              result.error ??
              (result.signal ? `信号 ${result.signal}` : `退出码 ${exitCode}`)
          else {
            try {
              output = await readReview(await runOutDir(taskDir))
            } catch (caught) {
              error = missingOutput(caught) ? '缺少 out/review.json' : errorMessage(caught)
            }
          }
        } else {
          const state = await executor.status(handle)
          if (state.running) {
            if (run.error === '超时') await executor.signal(handle, 'SIGKILL')
            else if (endedAt.getTime() - run.startedAt.getTime() > settings.timeout * 60_000) {
              db.update(runs).set({ error: '超时' }).where(eq(runs.id, run.id)).run()
              await executor.signal(handle, 'SIGTERM')
            }
            continue
          }
          error = run.error ?? (state.oom ? '内存不足（OOM）' : '进程丢失')
        }
        try {
          await executor.finish(handle)
        } finally {
          await removeSecrets(taskDir).catch(() => log(`${prefix} 删除任务密钥失败`))
        }
        ;({ logTail } = await extractSummary(taskDir, secrets))
      }

      if (error !== null) error = redact(error)
      const redactField = (text: string, max: number) =>
        Array.from(redact(text)).slice(0, max).join('')
      const saved = output
        ? {
            status: 'done' as const,
            verdict: output.verdict,
            summary: redactField(output.summary, 2000),
            checks: JSON.stringify(
              output.checks.map(({ command, passed, detail }) => ({
                command: redactField(command, 500),
                passed,
                detail: redactField(detail, 2000),
              })),
            ),
            acceptance: JSON.stringify(
              output.acceptance.map(({ item, met, evidence }) => ({
                item: redactField(item, 500),
                met,
                evidence: redactField(evidence, 1000),
              })),
            ),
            findings: JSON.stringify(
              output.findings.map(({ severity, path, line, scenario, body, known }) => ({
                severity,
                path: path === null ? null : redactField(path, 500),
                line,
                scenario: redactField(scenario, 2000),
                body: redactField(body, 4000),
                known,
              })),
            ),
          }
        : { status: 'failed' as const }
      db.transaction((tx) => {
        if (run)
          tx.update(runs)
            .set({ endedAt, exitCode, error, logTail })
            .where(eq(runs.id, run.id))
            .run()
        tx.update(reviews)
          .set({ ...saved, error, endedAt })
          .where(eq(reviews.id, review.id))
          .run()
      })
      log(
        output
          ? `${prefix} 评审完成：${output.verdict}，${output.findings.length} 条发现`
          : `${prefix} 评审失败：${error}`,
      )
      await cleanTaskDirs(db, settings.workspace, repo, issue, settings.keepRuns)
    } catch (caught) {
      log(`${prefix} 评审对账失败：${redact(errorMessage(caught))}`)
    }
  }
}

export async function recoverOrphanReviews(
  db: WorklingDatabase,
  workspace: string,
  log: (message: string) => void,
  now = new Date(),
): Promise<void> {
  const orphans = db
    .select({ reviewId: reviews.id, runId: runs.id, taskDir: runs.taskDir })
    .from(reviews)
    .innerJoin(runs, eq(reviews.runId, runs.id))
    .where(
      and(
        eq(reviews.status, 'running'),
        eq(runs.kind, 'review'),
        isNull(runs.pid),
        isNull(runs.container),
        isNull(runs.endedAt),
      ),
    )
    .all()
  for (const { reviewId, runId, taskDir } of orphans) {
    if (taskDir) {
      try {
        await removeSecrets(assertTaskDir(workspace, taskDir))
      } catch {
        log(`评审 #${reviewId} 删除任务密钥失败`)
      }
    }
    db.transaction((tx) => {
      tx.update(runs).set({ endedAt: now, error: '拉起中断' }).where(eq(runs.id, runId)).run()
      tx.update(reviews)
        .set({ status: 'queued', runId: null, model: null, effort: null })
        .where(eq(reviews.id, reviewId))
        .run()
    })
  }
}
