import { type ExecutorSettings } from '../config/executor.ts'
import { eq } from 'drizzle-orm'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { removeSecrets } from '../contract/secrets.ts'
import { type WorklingDatabase } from '../db/index.ts'
import { issues as issueStates, repos, runs } from '../db/schema.ts'
import { createExecutor, type Executor } from '../executor/index.ts'
import { ghEnv } from '../platform/github.ts'
import { assertTaskDir, readResult } from '../task/dir.ts'
import { type PiSettings } from '../config/pi.ts'
import type { Command } from '../runtime/types.ts'
import { extractSummary } from '../task/summary.ts'
import type { Settings } from '../config/env.ts'

import { errorMessage } from '../runtime/errors.ts'
import { landRun, neutralizeMentions, publishIssueResult, readRunIssueComment } from './land.ts'
import { mirrorPath } from './mirror.ts'
import { redactSecrets } from './secret-scan.ts'
type Log = (message: string) => void

async function cleanTaskDirs(
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

export async function reconcile({
  db,
  command,
  log,
  settings,
  pi,
  executorSettings,
  now = () => new Date(),
  executor = createExecutor(executorSettings, command, log),
}: {
  db: WorklingDatabase
  command: Command
  log: Log
  settings: Settings
  pi: PiSettings
  executorSettings: ExecutorSettings
  now?: () => Date
  executor?: Executor
}): Promise<void> {
  const rows = db
    .select({ issue: issueStates, repo: repos, run: runs })
    .from(issueStates)
    .innerJoin(repos, eq(issueStates.repoId, repos.id))
    .leftJoin(runs, eq(issueStates.lastRunId, runs.id))
    .where(eq(issueStates.status, 'running'))
    .all()
  for (const { issue, repo, run } of rows) {
    try {
      const current = now()
      let status: 'done' | 'failed' | 'canceled' = 'failed'
      let error: string | null = null
      let endedAt = current
      let exitCode: number | null = null
      let prUrl: string | undefined
      let prState: typeof issue.prState | undefined
      let readyToLand = false
      let delivery:
        | {
            taskDir: string
            landed: Extract<Awaited<ReturnType<typeof landRun>>, { status: 'done' }>
          }
        | undefined
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
          } else error = landed.error
        }
      }
      const summary = run?.taskDir
        ? await extractSummary(run.taskDir, [repo.token, pi.llmApiKey ?? ''])
        : { summary: null, reportResult: null, logTail: null }
      db.transaction((tx) => {
        tx.update(issueStates)
          .set({ status, updatedAt: current, prUrl, prState })
          .where(eq(issueStates.id, issue.id))
          .run()
        if (run)
          tx.update(runs)
            .set({ endedAt, exitCode, error, ...summary })
            .where(eq(runs.id, run.id))
            .run()
      })
      // 库是执行状态的事实来源；GitHub 同步失败不能回滚终态。
      const sync = async (args: string[], input?: string) => {
        try {
          await command(args, { env: ghEnv(repo.token, repo.host), input })
        } catch (error) {
          log(`${repo.ref} #${issue.number} 更新 GitHub 失败：${errorMessage(error)}`)
        }
      }
      if (repo.platform === 'github') {
        await sync([
          'gh',
          'issue',
          'edit',
          String(issue.number),
          '-R',
          repo.path,
          '--remove-label',
          'workling:running',
          '--add-label',
          status === 'done' ? 'workling:done' : 'workling:failed',
        ])
        if (delivery) {
          await publishIssueResult({
            ...delivery,
            repo,
            issue,
            command,
            llmApiKey: pi.llmApiKey,
            log,
          })
        } else if (status !== 'done') {
          let report = ''
          let explanation = ''
          const secrets = [repo.token, pi.llmApiKey ?? '']
          if (run?.taskDir) {
            const warn = (step: string) => log(`${repo.ref} #${issue.number} ${step}失败`)
            try {
              const taskDir = assertTaskDir(settings.workspace, run.taskDir)
              explanation = await readRunIssueComment(taskDir, warn)
              report = redactSecrets(await readFile(join(taskDir, 'report.md'), 'utf8'), secrets)
                .split(/\r?\n/)
                .slice(0, 20)
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
          const body = `workling：执行未完成（${error}）。\n\n- 机器：${settings.worker}\n- 耗时：${minutes} 分钟\n- 任务目录：${run?.taskDir ?? ''}\n\n${report ? `${report}\n\n` : ''}重新打上 workling:ready，或评论 \`/workling <补充说明>\` 即可重试。${explanation ? `\n\n### Pi 的说明\n\n${explanation}` : ''}`
          await sync(
            ['gh', 'issue', 'comment', String(issue.number), '-R', repo.path, '--body-file', '-'],
            neutralizeMentions(redactSecrets(body, secrets)),
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
    } catch (error) {
      log(`${repo.ref} #${issue.number} 对账失败：${errorMessage(error)}`)
    }
  }
}
