import { markComment } from './comment.ts'
import { type ExecutorSettings } from '../config/executor.ts'
import { and, count, eq } from 'drizzle-orm'
import { join } from 'node:path'
import { removeSecrets, writeLlmSecrets } from '../contract/secrets.ts'
import { CONTRACT_VERSION, writeSpec, type Spec } from '../contract/spec.ts'
import { type WorklingDatabase } from '../db/index.ts'
import { issues as issueStates, repos, runs } from '../db/schema.ts'
import { createExecutor, workerEnv, type Executor } from '../executor/index.ts'
import { ghEnv } from '../platform/github.ts'
import { docBranch, taskBranch } from '../issue/branch.ts'
import { readIssue } from '../issue/read.ts'
import { parseIssueRef } from '../issue/reference.ts'
import { createTaskDir, writeResult } from '../task/dir.ts'
import { type PiSettings } from '../config/pi.ts'
import type { Command } from '../runtime/types.ts'
import type { Settings } from '../config/env.ts'

import { errorMessage } from '../runtime/errors.ts'
import { syncMirror } from './mirror.ts'
type Log = (message: string) => void

async function prepareCheckout({
  workspace,
  taskDir,
  repo,
  issue,
  pi,
  command,
  signal,
}: {
  workspace: string
  taskDir: string
  repo: typeof repos.$inferSelect
  issue: { number: number; title: string; body: string }
  pi: PiSettings
  command: Command
  signal: AbortSignal
}): Promise<Spec['repo'] | { error: string }> {
  const mirror = await syncMirror({ workspace, repo, command, signal })
  const doc = docBranch(issue.body)
  if (doc && 'error' in doc) return doc
  const mirrorOptions = { cwd: mirror, signal }
  const base =
    doc?.name ??
    (await command(['gh', 'api', `repos/${repo.path}`, '--jq', '.default_branch'], {
      env: ghEnv(repo.token, repo.host),
      signal,
    }))
  const ref = `refs/heads/${base}`
  if (doc) {
    // 查询不到引用与 Git 命令失败是两类结果；只在前者报告输入错误。
    const refs = await command(['git', 'for-each-ref', '--format=%(refname)', ref], mirrorOptions)
    if (!refs.split('\n').includes(ref)) return { error: `文档分支「${doc.name}」不存在` }
  } else {
    await command(['git', 'check-ref-format', ref], mirrorOptions)
  }
  const baseRef = await command(
    ['git', 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    mirrorOptions,
  )
  const branch = taskBranch(issue.number, issue.title)
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
  await command(['git', 'switch', '-c', branch, baseRef], options)
  return { baseRef, branch, ...(doc ? { docBranch: doc.name } : {}) }
}

export async function launchQueued({
  db,
  command,
  log,
  settings,
  pi,
  executorSettings,
  signal,
  triggers,
  now = () => new Date(),
  executor = createExecutor(executorSettings, command, log),
}: {
  db: WorklingDatabase
  command: Command
  log: Log
  settings: Settings
  pi: PiSettings
  executorSettings: ExecutorSettings
  signal: AbortSignal
  triggers?: Map<number, string>
  now?: () => Date
  executor?: Executor
}): Promise<void> {
  let slots =
    executorSettings.concurrency -
    db.select({ count: count() }).from(issueStates).where(eq(issueStates.status, 'running')).get()!
      .count
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
  for (const { issue, repo } of rows) {
    if (slots <= 0 || signal.aborted) break
    if (repo.host !== 'github.com') {
      log(`${repo.ref} #${issue.number} 跳过：M1 只支持 github.com`)
      continue
    }
    slots--
    let record: typeof runs.$inferSelect | undefined
    let handle: Awaited<ReturnType<Executor['start']>> | undefined
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
      const { title, body } = await readIssue({
        ref,
        dir: join(taskDir, 'input'),
        command,
        env: ghEnv(repo.token, repo.host),
      })
      const checkout = await prepareCheckout({
        workspace: settings.workspace,
        taskDir,
        repo,
        issue: { number: issue.number, title, body },
        pi,
        command,
        signal,
      })
      if ('error' in checkout) {
        await writeResult(taskDir, {
          exitCode: null,
          signal: null,
          finishedAt: now().toISOString(),
          error: checkout.error,
        })
      } else {
        db.update(runs)
          .set({ branch: checkout.branch, baseRef: checkout.baseRef })
          .where(eq(runs.id, record.id))
          .run()
        await writeSpec(taskDir, {
          contract: CONTRACT_VERSION,
          kind: 'implement',
          issue: { ref: issueRef, title },
          repo: checkout,
          model: {
            codex: pi.model,
            effort: pi.effort,
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
      const trigger = triggers?.get(issue.id)
      const body = `workling：已领取，开始执行。\n\n- 机器：${settings.worker}\n- 开始时间：${record!.startedAt.toISOString()}\n- 任务目录：${record!.taskDir}${trigger ? `\n- 触发：${trigger}` : ''}`
      await command(
        ['gh', 'issue', 'comment', String(issue.number), '-R', repo.path, '--body-file', '-'],
        { env: ghEnv(repo.token, repo.host), input: markComment(body) },
      )
    } catch (error) {
      log(`${repo.ref} #${issue.number} 发送领取评论失败：${errorMessage(error)}`)
    } finally {
      triggers?.delete(issue.id)
    }
  }
}
