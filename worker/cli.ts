#!/usr/bin/env bun
// @env node
// worker 入口：只认识运行目录与 src/contract/ 中的契约，不读取主体的数据库和配置。
import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertTaskDir, writeResult } from '../src/contract/result.ts'
import { run, withShutdown } from './process.ts'
import { runTask } from './task.ts'

const usage = `用法：bun worker/cli.ts <命令>
命令（由 workling serve 调用）：
  task <issue 引用> <任务目录>   在任务目录中执行一次运行，结果写入 result.json 与 out/`

export async function main(args: string[]): Promise<number> {
  const [command, ref, taskDir] = args
  if (command !== 'task') {
    console.log(usage)
    return 0
  }
  if (!ref || !taskDir || args.length !== 3)
    throw new Error('用法：bun worker/cli.ts task <issue 引用> <任务目录>')
  if (!/^[a-z]+:[^#\s]+#\d+$/.test(ref)) throw new Error(`无法识别的 Issue 引用：${ref}`)
  // 与主体使用相同的工作区约定，任务目录只能位于 <工作区>/tasks/ 下。
  const workspace = resolve(process.cwd(), process.env.WORKLING_WORKSPACE ?? '.runtime')
  const dir = assertTaskDir(workspace, taskDir)
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
      const status = await runTask({ ref, dir, command: run, env: process.env, signal, out })
      result = {
        exitCode: status.code,
        signal: status.signal,
        finishedAt: new Date().toISOString(),
        error: status.error,
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

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
