import { type ExecutorSettings } from '../config/executor.ts'
import { and, count, eq } from 'drizzle-orm'
import { join } from 'node:path'
import { CONTRACT_VERSION, writeSpec } from '../contract/spec.ts'
import { type WorklingDatabase } from '../db/index.ts'
import { issues as issueStates, repos, runs } from '../db/schema.ts'
import { createExecutor, type Executor } from '../executor/index.ts'
import { ghEnv } from '../platform/github.ts'
import { readIssue } from '../issue/read.ts'
import { parseIssueRef } from '../issue/reference.ts'
import { createTaskDir } from '../task/dir.ts'
import { type PiSettings } from '../config/pi.ts'
import type { Command } from '../runtime/types.ts'
import type { Settings } from '../config/env.ts'

import { errorMessage } from '../runtime/errors.ts'
type Log = (message: string) => void

export async function launchQueued({
  db,
  command,
  log,
  settings,
  pi,
  executorSettings,
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
    if (slots <= 0) break
    if (repo.host !== 'github.com') {
      log(`${repo.ref} #${issue.number} 跳过：M1 只支持 github.com`)
      continue
    }
    slots--
    let record: typeof runs.$inferSelect | undefined
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
      const inherited = ghEnv(repo.token, repo.host)
      const { title } = await readIssue({
        ref,
        dir: join(taskDir, 'input'),
        command,
        env: inherited,
      })
      await writeSpec(taskDir, {
        contract: CONTRACT_VERSION,
        kind: 'implement',
        issue: { ref: issueRef, title },
        model: {
          codex: pi.model,
          effort: pi.effort,
          ...(pi.piModel !== null ? { pi: pi.piModel } : {}),
        },
        git: { name: pi.gitName, email: pi.gitEmail },
      })
      // 模型和提交身份来自契约；LLM 接入只使用当前配置。
      for (const name of [
        'WORKLING_MODEL',
        'WORKLING_EFFORT',
        'WORKLING_GIT_NAME',
        'WORKLING_GIT_EMAIL',
        'WORKLING_PI_MODEL',
        'WORKLING_LLM_BASE_URL',
        'WORKLING_LLM_API_KEY',
        'WORKLING_LLM_API',
      ])
        delete inherited[name]
      const env = {
        ...inherited,
        WORKLING_WORKSPACE: settings.workspace,
        ...(pi.llmBaseUrl !== null
          ? {
              WORKLING_LLM_BASE_URL: pi.llmBaseUrl,
              WORKLING_LLM_API_KEY: pi.llmApiKey!,
              WORKLING_LLM_API: pi.llmApi,
            }
          : {}),
      }
      const handle = await executor.start({
        runId: record.id,
        ref: issueRef,
        taskDir,
        env,
      })
      const runId = record.id
      db.transaction((tx) => {
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
        { env: ghEnv(repo.token, repo.host), input: body },
      )
    } catch (error) {
      log(`${repo.ref} #${issue.number} 发送领取评论失败：${errorMessage(error)}`)
    } finally {
      triggers?.delete(issue.id)
    }
  }
}
