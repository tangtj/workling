import { markComment } from './comment.ts'
import { and, desc, eq, ne, inArray } from 'drizzle-orm'
import { join } from 'node:path'
import { removeSecrets, writeLlmSecrets } from '../contract/secrets.ts'
import { CONTRACT_VERSION, writeSpec, type Spec } from '../contract/spec.ts'
import { type WorklingDatabase } from '../db/index.ts'
import { issues as issueStates, repos, runs, feedback } from '../db/schema.ts'
import { createExecutor, workerEnv, type Executor } from '../executor/index.ts'
import { defaultBranch as readDefaultBranch, ghEnv } from '../platform/github.ts'
import {
  canPlan,
  readParent,
  readSubIssues,
  previousSibling,
  type SubIssue,
} from '../issue/chain.ts'
import { docBranch, findDirective, planMode, taskBranch } from '../issue/branch.ts'
import { readIssue } from '../issue/read.ts'
import { parseIssueRef } from '../issue/reference.ts'
import { writeResult } from '../contract/result.ts'
import { createTaskDir } from './task-dir.ts'
import { type PiSettings } from '../config/pi.ts'
import type { Command } from '../runtime/types.ts'
import type { ReconcileOptions } from './reconcile.ts'
import { countRunningTasks } from './slots.ts'

import { errorMessage } from '../runtime/errors.ts'
import { writeRunContext } from './context.ts'
import { syncMirror } from './mirror.ts'
import { selectBatch } from './rework.ts'
type Log = (message: string) => void

const waiting = new Map<number, string>()

export type ChainCache = {
  subs: Map<number, Promise<SubIssue[]>>
  titles: Map<number, Promise<string>>
}

function cached<T>(map: Map<number, Promise<T>>, key: number, load: () => Promise<T>): Promise<T> {
  let value = map.get(key)
  if (!value) {
    value = load().catch((error: unknown) => {
      map.delete(key)
      throw error
    })
    map.set(key, value)
  }
  return value
}

export async function chainGate(
  db: WorklingDatabase,
  repo: typeof repos.$inferSelect,
  issue: typeof issueStates.$inferSelect,
  command: Command,
  signal: AbortSignal,
  cache?: ChainCache,
) {
  const rework = issue.prState === 'open'
  try {
    const parent = await readParent({ repo, number: issue.number, command, signal })
    if (!parent) return { kind: 'free' as const }
    const subs = await cached(cache?.subs ?? new Map(), parent.number, () =>
      readSubIssues({ repo, number: parent.number, command, signal }),
    )
    const position = subs.findIndex((sub) => sub.number === issue.number) + 1
    const title = await cached(cache?.titles ?? new Map(), parent.number, async () => {
      const parentData: unknown = JSON.parse(
        await command(['gh', 'api', `repos/${repo.path}/issues/${parent.number}`], {
          env: ghEnv(repo.token, repo.host),
          signal,
        }),
      )
      if (
        !parentData ||
        typeof parentData !== 'object' ||
        !('title' in parentData) ||
        typeof parentData.title !== 'string'
      )
        throw new Error('父 Issue 标题格式无效')
      return parentData.title
    })
    const chain = { parent: parent.number, title, position, total: subs.length }
    if (rework) return { kind: 'free' as const, chain }
    const previous = previousSibling(subs, issue.number)
    if (!previous) return { kind: 'free' as const, chain }
    if (!previous.sameRepo)
      return {
        kind: 'error' as const,
        error: `不支持跨仓库的子 Issue（上一个是 #${previous.number}）`,
      }
    const row = db
      .select()
      .from(issueStates)
      .where(and(eq(issueStates.repoId, repo.id), eq(issueStates.number, previous.number)))
      .get()
    if (
      row?.prState === 'merged' ||
      (previous.state === 'closed' && previous.stateReason === 'completed')
    )
      return { kind: 'base' as const, chain }
    const run = row?.lastRunId
      ? db.select().from(runs).where(eq(runs.id, row.lastRunId)).get()
      : undefined
    if (
      row?.status === 'done' &&
      row.prState === 'open' &&
      run?.reportResult?.startsWith('完成') &&
      run.branch
    )
      return { kind: 'stack' as const, branch: run.branch, previous: previous.number, chain }
    return {
      kind: 'wait' as const,
      reason: `上一个子任务 #${previous.number}（${row?.status ?? '无记录'}）`,
    }
  } catch (error) {
    if (rework) return { kind: 'free' as const }
    return { kind: 'wait' as const, reason: `读取父子关系失败：${errorMessage(error)}` }
  }
}

async function prepareCheckout({
  workspace,
  taskDir,
  repo,
  issue,
  stackOn,
  runId,
  previous,
  kind,
  pi,
  command,
  log,
  signal,
}: {
  workspace: string
  taskDir: string
  repo: typeof repos.$inferSelect
  issue: { number: number; title: string; body: string }
  stackOn?: { branch: string }
  runId: number
  previous: { branch: string | null; prState: 'open' | 'merged' | 'closed' | null }
  kind: Spec['kind']
  pi: PiSettings
  command: Command
  log: Log
  signal: AbortSignal
}): Promise<(Spec['repo'] & { start: string; target: string }) | { error: string }> {
  const mirror = await syncMirror({ workspace, repo, command, signal })
  const doc = docBranch(issue.body)
  if (doc && 'error' in doc) return doc
  const mirrorOptions = { cwd: mirror, signal }
  const branchRef = (branch: string) => `refs/heads/${branch}`
  const hasRef = async (ref: string) => {
    // 查询不到引用与 Git 命令失败是两类结果；只在前者报告输入错误。
    const refs = await command(['git', 'for-each-ref', '--format=%(refname)', ref], mirrorOptions)
    return refs.split('\n').includes(ref)
  }
  if (doc && !(await hasRef(branchRef(doc.name)))) return { error: `文档分支「${doc.name}」不存在` }

  const continuedBranch =
    !stackOn &&
    previous.branch?.startsWith(`workling/${issue.number}-`) &&
    (previous.prState === null || previous.prState === 'open') &&
    (await hasRef(branchRef(previous.branch)))
      ? previous.branch
      : undefined
  if (kind === 'rework' && !continuedBranch)
    return { error: `PR 分支「${previous.branch ?? '未知'}」不存在，无法返工` }
  if (
    stackOn &&
    (!stackOn.branch.startsWith('workling/') || !(await hasRef(branchRef(stackOn.branch))))
  )
    return { error: `上一个子任务的分支「${stackOn.branch}」不存在` }
  const defaultBranch = async () => {
    const name = await readDefaultBranch({ repo, command, signal })
    await command(['git', 'check-ref-format', branchRef(name)], mirrorOptions)
    return name
  }
  let start = stackOn?.branch ?? doc?.name
  if (!start) start = await defaultBranch()
  else if (doc && !stackOn && !continuedBranch) {
    const base = await defaultBranch()
    const paths = await command(
      ['git', 'diff', '--name-only', '-z', `${branchRef(base)}...${branchRef(doc.name)}`],
      mirrorOptions,
    )
    const changes = paths
      ? await command(
          [
            'git',
            'diff',
            '--name-only',
            '-z',
            branchRef(base),
            branchRef(doc.name),
            '--',
            ...paths
              .split('\0')
              .filter(Boolean)
              .map((path) => `:(literal)${path}`),
          ],
          mirrorOptions,
        )
      : ''
    if (!changes) {
      start = base
      log(`#${issue.number} 文档分支「${doc.name}」的改动已在 ${base} 中，改从 ${base} 切出`)
    }
  }
  let ref: string
  let branch: string
  if (continuedBranch) {
    branch = continuedBranch
    ref = branchRef(branch)
  } else {
    ref = branchRef(start)
    branch = taskBranch(issue.number, issue.title)
    if (await hasRef(branchRef(branch))) branch = `${branch}-${runId}`
  }
  const baseRef = await command(
    ['git', 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    mirrorOptions,
  )
  const options = await cloneCheckout({ taskDir, mirror, pi, command, signal })
  await command(['git', 'switch', '-c', branch, baseRef], options)
  return {
    baseRef,
    branch,
    start,
    // PR 合入的分支：堆叠时是上游任务分支，否则是默认分支（文档分支任务也合入默认分支）。
    target: stackOn?.branch ?? (await defaultBranch()),
    ...(doc ? { docBranch: doc.name } : {}),
    ...(continuedBranch ? { continued: true } : {}),
  }
}

export async function cloneCheckout({
  taskDir,
  mirror,
  pi,
  command,
  signal,
}: {
  taskDir: string
  mirror: string
  pi: PiSettings
  command: Command
  signal: AbortSignal
}) {
  const cwd = join(taskDir, 'repo')
  await command(['git', 'clone', '--no-hardlinks', '--no-checkout', '--dissociate', mirror, cwd], {
    signal,
  })
  const options = { cwd, signal }
  // 本机进程仍可写镜像；禁用 push 只防误操作，镜像隔离留给 M4。
  await command(['git', 'remote', 'set-url', 'origin', mirror], options)
  await command(
    ['git', 'config', '--local', 'remote.origin.pushurl', 'no-push://disabled'],
    options,
  )
  await command(['git', 'config', '--local', 'user.name', pi.gitName], options)
  await command(['git', 'config', '--local', 'user.email', pi.gitEmail], options)
  return options
}

export type LaunchOptions = ReconcileOptions & { signal: AbortSignal }

export async function launchQueued({
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
  let slots = executorSettings.concurrency - countRunningTasks(db)
  const rows = db
    .select({ issue: issueStates, repo: repos })
    .from(issueStates)
    .innerJoin(repos, eq(issueStates.repoId, repos.id))
    .where(
      and(eq(issueStates.status, 'queued'), eq(repos.enabled, true), eq(repos.platform, 'github')),
    )
    .orderBy(issueStates.number, repos.id)
    .all()
  if (executorSettings.sandbox === 'docker' && !pi.llmBaseUrl) {
    if (rows.length > 0) log('docker 沙箱需要在设置页配置 LLM 接入地址，暂不拉起任务')
    return
  }
  if (slots <= 0) return
  const caches = new Map<number, ChainCache>()
  for (const { issue, repo } of rows) {
    if (slots <= 0 || signal.aborted) break
    if (repo.host !== 'github.com') {
      log(`${repo.ref} #${issue.number} 跳过：M1 只支持 github.com`)
      continue
    }
    let cache = caches.get(repo.id)
    if (!cache) {
      cache = { subs: new Map(), titles: new Map() }
      caches.set(repo.id, cache)
    }
    const gate = await chainGate(db, repo, issue, command, signal, cache)
    if (gate.kind === 'wait') {
      if (waiting.get(issue.id) !== gate.reason)
        log(`${repo.ref} #${issue.number} 等待${gate.reason}`)
      waiting.set(issue.id, gate.reason)
      continue
    }
    waiting.delete(issue.id)
    slots--
    let record: typeof runs.$inferSelect | undefined
    let handle: Awaited<ReturnType<Executor['start']>> | undefined
    let kind: Spec['kind'] = 'implement'
    let originalStatuses: Array<{ id: number; status: typeof feedback.$inferSelect.status }> = []
    try {
      const startedAt = now()
      const issueRef = `github:${repo.path}#${issue.number}`
      const ref = parseIssueRef(issueRef)
      const taskDir = await createTaskDir(settings.workspace, ref, startedAt)
      record = db
        .insert(runs)
        .values({ issueId: issue.id, worker: settings.worker, taskDir, startedAt })
        .returning()
        .get()
      const included = db.transaction((tx) => {
        const previousRun = issue.lastRunId
          ? tx.select().from(runs).where(eq(runs.id, issue.lastRunId)).get()
          : undefined
        const rows = tx.select().from(feedback).where(eq(feedback.issueId, issue.id)).all()
        const observed = previousRun ? selectBatch({ issue, run: previousRun }, rows) : []
        const claim = rows.filter((row) => row.status === 'pending' || observed.includes(row))
        const reviewIds = claim
          .filter((row) => row.source === 'review')
          .map((row) => row.externalId)
        originalStatuses = rows
          .filter(
            (row) =>
              claim.includes(row) ||
              (row.source === 'review_comment' &&
                row.reviewId !== null &&
                reviewIds.includes(row.reviewId) &&
                (row.status === 'ignored' || row.status === 'observed')),
          )
          .map((row) => ({
            id: row.id,
            status: row.status === 'observed' && claim.includes(row) ? 'pending' : row.status,
          }))
        if (claim.length)
          tx.update(feedback)
            .set({ status: 'included', runId: record!.id })
            .where(
              inArray(
                feedback.id,
                claim.map((row) => row.id),
              ),
            )
            .run()
        const selected = tx.select().from(feedback).where(eq(feedback.runId, record!.id)).all()
        const selectedReviewIds = selected
          .filter((row) => row.source === 'review')
          .map((row) => row.externalId)
        if (selectedReviewIds.length)
          tx.update(feedback)
            .set({ status: 'included', runId: record!.id })
            .where(
              and(
                eq(feedback.issueId, issue.id),
                eq(feedback.source, 'review_comment'),
                inArray(feedback.reviewId, selectedReviewIds),
                inArray(feedback.status, ['ignored', 'observed']),
              ),
            )
            .run()
        return tx
          .select()
          .from(feedback)
          .where(eq(feedback.runId, record!.id))
          .orderBy(feedback.createdAt, feedback.id)
          .all()
      })
      kind = included.length && issue.prState === 'open' ? 'rework' : 'implement'
      db.update(runs).set({ kind }).where(eq(runs.id, record.id)).run()
      const previous = db
        .select({ branch: runs.branch })
        .from(runs)
        .where(
          and(
            eq(runs.issueId, issue.id),
            ne(runs.id, record.id),
            ne(runs.kind, 'review'),
            ne(runs.branch, ''),
          ),
        )
        .orderBy(desc(runs.id))
        .get()
      const { title, body } = await readIssue({
        ref,
        dir: join(taskDir, 'input'),
        command,
        env: ghEnv(repo.token, repo.host),
      })
      let planError: { error: string } | undefined
      if (kind === 'implement') {
        const mode = planMode(body)
        if (typeof mode === 'object') planError = mode
        else if (mode) {
          if (findDirective(body, '分支') !== undefined)
            planError = { error: '拆解需求不支持「分支：」行' }
          else if (!canPlan(await readSubIssues({ repo, number: issue.number, command, signal })))
            planError = {
              error:
                '已有未关闭或已完成的子 Issue，不再拆解；请直接编辑子 Issue，或把子 Issue 全部关闭为「不计划」后重试',
            }
          else {
            kind = 'plan'
            db.update(runs).set({ kind }).where(eq(runs.id, record.id)).run()
          }
        }
      }
      const checkout =
        gate.kind === 'error'
          ? { error: gate.error }
          : included.length && (issue.prState === 'merged' || issue.prState === 'closed')
            ? { error: 'PR 已合入或关闭，不再返工；新需求请另开 Issue' }
            : (planError ??
              (await prepareCheckout({
                workspace: settings.workspace,
                taskDir,
                repo,
                ...(gate.kind === 'stack' ? { stackOn: { branch: gate.branch } } : {}),
                issue: { number: issue.number, title, body },
                runId: record.id,
                previous: { branch: previous?.branch ?? null, prState: issue.prState },
                kind,
                pi,
                command,
                log,
                signal,
              })))
      if ('error' in checkout) {
        await writeResult(taskDir, {
          exitCode: null,
          signal: null,
          finishedAt: now().toISOString(),
          error: checkout.error,
        })
      } else {
        const { start, target, ...specRepo } = checkout
        db.update(runs)
          .set({
            branch: checkout.branch,
            baseRef: checkout.baseRef,
            stackBranch: gate.kind === 'stack' ? gate.branch : null,
          })
          .where(eq(runs.id, record.id))
          .run()
        await writeRunContext({
          db,
          taskDir,
          repo,
          issue,
          runId: record.id,
          kind,
          checkout: { ...specRepo, start, target },
          ...(gate.kind !== 'error' && 'chain' in gate && gate.chain
            ? {
                chain: {
                  ...gate.chain,
                  kind: gate.kind,
                  ...('previous' in gate ? { previous: gate.previous, branch: gate.branch } : {}),
                },
              }
            : {}),
          command: (args, options) => command(args, { ...options, signal }),
          secrets: [repo.token, pi.llmApiKey ?? ''],
          log,
        })
        await writeSpec(taskDir, {
          contract: CONTRACT_VERSION,
          kind,
          issue: { ref: issueRef, title },
          repo: specRepo,
          model: {
            codex: kind === 'plan' ? (pi.planModel ?? pi.model) : pi.model,
            effort: kind === 'plan' ? (pi.planEffort ?? 'high') : pi.effort,
            ...(pi.piModel !== null ? { pi: pi.piModel } : {}),
          },
          git: { name: pi.gitName, email: pi.gitEmail },
        })
        if (pi.llmBaseUrl !== null) {
          await writeLlmSecrets(taskDir, {
            baseUrl: pi.llmBaseUrl,
            apiKey: pi.llmApiKey!,
            api: pi.llmApi,
          })
        }
        const env = {
          ...workerEnv(process.env),
          WORKLING_WORKSPACE: settings.workspace,
        }
        signal.throwIfAborted()
        handle = await executor.start({ runId: record.id, ref: issueRef, taskDir, env })
      }
      const runId = record.id
      db.transaction((tx) => {
        if (handle)
          tx.update(runs)
            .set({ pid: handle.pid, container: handle.container })
            .where(eq(runs.id, runId))
            .run()
        tx.update(issueStates)
          .set({ status: 'running', lastRunId: runId, updatedAt: now() })
          .where(eq(issueStates.id, issue.id))
          .run()
      })
    } catch (error) {
      // 未拉起的运行不会进入对账，由启动流程清理已写入的密钥。
      if (!handle && record?.taskDir)
        await removeSecrets(record.taskDir).catch(() => {
          log(`${repo.ref} #${issue.number} 删除任务密钥失败`)
        })
      if (record)
        db.transaction((tx) => {
          for (const row of originalStatuses)
            tx.update(feedback)
              .set({ status: row.status, runId: null })
              .where(and(eq(feedback.id, row.id), eq(feedback.runId, record!.id)))
              .run()
        })
      if (record)
        db.update(runs)
          .set({ endedAt: now(), error: `拉起失败：${errorMessage(error)}` })
          .where(eq(runs.id, record.id))
          .run()
      log(`${repo.ref} #${issue.number} 拉起失败：${errorMessage(error)}`)
      continue
    }
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
          'workling:queued',
          '--add-label',
          'workling:running',
        ],
        { env: ghEnv(repo.token, repo.host) },
      )
    } catch (error) {
      log(`${repo.ref} #${issue.number} 更新标签失败：${errorMessage(error)}`)
    }
    try {
      const included = db
        .select()
        .from(feedback)
        .where(eq(feedback.runId, record!.id))
        .orderBy(feedback.createdAt, feedback.id)
        .all()
      const names = {
        issue_comment: 'Issue 评论',
        pr_comment: 'PR 评论',
        review_comment: '行内评论',
        review: 'Review',
      }
      const lines = included
        .slice(0, 10)
        .map((row) => `- ${names[row.source]} · @${row.authorLogin} · ${row.url}`)
      if (included.length > 10) lines.push(`等 ${included.length} 条`)
      const first =
        kind === 'plan'
          ? 'workling：已领取，开始拆解需求。'
          : kind === 'rework'
            ? 'workling：收到 PR 反馈，开始返工。'
            : 'workling：已领取，开始执行。'
      const body = `${first}\n\n- 机器：${settings.worker}\n- 开始时间：${record!.startedAt.toISOString()}\n- 任务目录：${record!.taskDir}${lines.length ? `\n\n触发反馈：\n${lines.join('\n')}` : ''}`
      await command(
        ['gh', 'issue', 'comment', String(issue.number), '-R', repo.path, '--body-file', '-'],
        { env: ghEnv(repo.token, repo.host), input: markComment(body) },
      )
    } catch (error) {
      log(`${repo.ref} #${issue.number} 发送领取评论失败：${errorMessage(error)}`)
    }
  }
}
