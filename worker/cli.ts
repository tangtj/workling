#!/usr/bin/env bun
// @env node
// worker 入口：只认识运行目录与 src/contract/ 中的契约，不读取主体的数据库和配置。
import { appendFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { assertTaskDir, writeResult } from '../src/contract/result.ts'
import { readSpec } from '../src/contract/spec.ts'
import { run, withShutdown } from './process.ts'
import { prepareSample, readSample, resolveSample, SAMPLES_DIR } from './samples.ts'
import { runTask } from './task.ts'

const usage = `用法：workling-worker <命令>（或 bun worker/cli.ts <命令>）
命令：
  run <运行目录>                       在准备好的运行目录中执行一次，产出写入 out/ 与 result.json
  prepare <样例> <运行目录> [选项]     把样例展开成运行目录；样例可写 worker/samples/ 下的名称或路径
      --codex-model <模型>  --effort <low|medium|high|xhigh>  --pi-model <模型>
  samples                              列出 worker/samples/ 下的样例
内部命令（由 workling serve 调用）：
  task <issue 引用> <任务目录>        同 run，但要求任务目录位于 <工作区>/tasks/ 下`

async function execute(ref: string, dir: string, tee: boolean): Promise<number> {
  return withShutdown(async (signal) => {
    let exitCode = 1
    let result: Parameters<typeof writeResult>[1]
    try {
      const out = tee
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

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args
  if (command === 'task') {
    const [ref, taskDir] = rest
    if (!ref || !taskDir || rest.length !== 2)
      throw new Error('用法：bun worker/cli.ts task <issue 引用> <任务目录>')
    if (!/^[a-z]+:[^#\s]+#\d+$/.test(ref)) throw new Error(`无法识别的 Issue 引用：${ref}`)
    // 与主体使用相同的工作区约定，任务目录只能位于 <工作区>/tasks/ 下。
    const workspace = resolve(process.cwd(), process.env.WORKLING_WORKSPACE ?? '.runtime')
    const dir = assertTaskDir(workspace, taskDir)
    return execute(ref, dir, process.env.WORKLING_TASK_TEE === '1')
  }
  if (command === 'run') {
    if (rest.length !== 1) throw new Error('用法：workling-worker run <运行目录>')
    const dir = resolve(rest[0]!)
    // 单独运行时没有主体传入的引用，以 spec.json 为准。
    const spec = await readSpec(dir)
    return execute(spec.issue.ref, dir, true)
  }
  if (command === 'prepare') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        'codex-model': { type: 'string' },
        effort: { type: 'string' },
        'pi-model': { type: 'string' },
      },
    })
    if (positionals.length !== 2)
      throw new Error('用法：workling-worker prepare <样例> <运行目录> [选项]')
    const effort = values.effort
    if (effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(effort))
      throw new Error(`--effort 的值无效：${effort}`)
    const dest = resolve(positionals[1]!)
    const spec = await prepareSample({
      sample: resolveSample(positionals[0]!),
      dest,
      command: run,
      model: {
        ...(values['codex-model'] ? { codex: values['codex-model'] } : {}),
        ...(effort ? { effort: effort as 'low' | 'medium' | 'high' | 'xhigh' } : {}),
        ...(values['pi-model'] ? { pi: values['pi-model'] } : {}),
      },
    })
    console.log(
      `已准备 ${dest}（${spec.kind}，codex ${spec.model.codex} / ${spec.model.effort}）\n需要自定义模型服务时写入 ${join(dest, 'secrets/llm.json')}，然后运行：workling-worker run ${dest}`,
    )
    return 0
  }
  if (command === 'samples') {
    for (const entry of await readdir(SAMPLES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sample = await readSample(join(SAMPLES_DIR, entry.name))
      console.log(`${entry.name}\t${sample.kind}\t${sample.issue.title}`)
    }
    return 0
  }
  console.log(usage)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
