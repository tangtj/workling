#!/usr/bin/env bun
// @env node
import { and, eq } from 'drizzle-orm'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { issues, repos, runs } from './db/schema.ts'
import { runTask } from './task/index.ts'
import { assertTaskDir, writeResult } from './task/dir.ts'
import { resetPassword } from './web/auth.ts'
import { openDatabase } from './db/index.ts'
import { parseIssueRef } from './issue/reference.ts'
import { run, withShutdown } from './runtime/process.ts'
import { readExecutorSettings } from './config/executor.ts'
import { createExecutor } from './executor/index.ts'
import { readSettings } from './config/env.ts'
import { serve } from './serve/index.ts'
import { readVersion } from './runtime/version.ts'

const usage = `用法：bun src/cli.ts <命令>
命令：
  version / --version / -v 显示版本
  serve                  启动服务：轮询 Issue、拉起任务、对账、管理页
  cancel <issue 引用>    取消运行中的任务
  reset-password         重置管理密码
内部命令（由 watch 调用，不要手动运行）：
  task <issue 引用> <任务目录>
支持的引用格式：
  github:owner/repo#12
  gitlab:group/sub/proj#3
  https://github.com/owner/repo/issues/12
  https://gitlab.com/group/sub/proj/-/issues/3`

export async function main(args: string[]): Promise<number> {
  const [command, ref] = args
  if (['version', '--version', '-v'].includes(command ?? '')) {
    console.log(readVersion())
    return 0
  }
  if (command === 'cancel') {
    if (!ref || args.length !== 2) throw new Error('用法：bun src/cli.ts cancel <issue 引用>')
    const reference = parseIssueRef(ref, process.env.WORKLING_GITLAB_HOST || 'gitlab.com')
    const settings = readSettings()
    const { db, close } = await openDatabase(settings.workspace)
    try {
      const executor = createExecutor(readExecutorSettings(db), run)
      const row = db
        .select({ issue: issues, run: runs })
        .from(issues)
        .innerJoin(repos, eq(issues.repoId, repos.id))
        .leftJoin(runs, eq(issues.lastRunId, runs.id))
        .where(
          and(
            eq(repos.platform, reference.platform),
            eq(repos.path, reference.project),
            eq(issues.number, reference.iid),
          ),
        )
        .get()
      if (
        !row ||
        row.issue.status !== 'running' ||
        !row.run ||
        row.run.endedAt ||
        !row.run.taskDir ||
        !(await executor.status({ ...row.run, taskDir: row.run.taskDir })).running
      )
        throw new Error(`没有运行中的任务：${ref}`)
      db.update(runs).set({ error: '已取消' }).where(eq(runs.id, row.run.id)).run()
      await executor.signal({ ...row.run, taskDir: row.run.taskDir }, 'SIGTERM')
      console.log('已发送取消信号，watch 下一轮对账后标记为 workling:failed')
    } finally {
      close()
    }
    return 0
  }
  if (command === 'reset-password') {
    const settings = readSettings()
    const { db, close } = await openDatabase(settings.workspace)
    try {
      const password = await resetPassword(db)
      console.log(`新的管理密码：${password}`)
      console.log('已登录的会话已全部失效')
    } finally {
      close()
    }
    return 0
  }
  if (command === 'serve') {
    await withShutdown((signal) => serve({ settings: readSettings(), signal }))
    return 0
  }
  if (command === 'task') {
    if (!ref || !args[2] || args.length !== 3)
      throw new Error('用法：bun src/cli.ts task <issue 引用> <任务目录>')
    const issue = parseIssueRef(ref, process.env.WORKLING_GITLAB_HOST || 'gitlab.com')
    const settings = readSettings()
    const dir = assertTaskDir(settings.workspace, args[2])
    return withShutdown(async (signal) => {
      let exitCode = 1
      let result: Parameters<typeof writeResult>[1]
      try {
        const out =
          process.env.WORKLING_TASK_TEE === '1'
            ? (line: string) => {
                console.log(line)
                appendFileSync(join(dir, 'task.log'), `${line}\n`)
              }
            : undefined
        const status = await runTask({
          ref: issue,
          dir,
          command: run,
          env: process.env,
          signal,
          out,
        })
        result = {
          exitCode: status.code,
          signal: status.signal,
          finishedAt: new Date().toISOString(),
        }
        exitCode = signal.aborted ? 1 : (status.code ?? 1)
      } catch (error) {
        result = {
          exitCode: null,
          signal: null,
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }
      }
      if (signal.aborted) result.signal = 'SIGTERM'
      await writeResult(dir, result)
      return exitCode
    })
  }
  console.log(usage)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
