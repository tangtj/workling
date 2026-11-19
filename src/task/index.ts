import { appendFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeOutResult } from '../contract/out.ts'
import { CONTRACT_VERSION, readSpec } from '../contract/spec.ts'
import type { IssueRef } from '../issue/reference.ts'
import { errorMessage } from '../runtime/errors.ts'
import { PI_CLI, ROOT } from '../runtime/paths.ts'
import { streamProcess } from '../runtime/process.ts'
import { createPiEventFormatter, duration, time } from '../task/pi-events.ts'
import type { Command, Environment, ExitStatus } from '../runtime/types.ts'
import { redact, reportResultLine } from './summary.ts'

export async function runTask(options: {
  ref: IssueRef
  dir: string
  command: Command
  env: Environment
  signal: AbortSignal
  pi?: string[]
  wait?: typeof streamProcess
  out?: (line: string) => void
  now?: () => Date
}): Promise<ExitStatus & { error?: string }> {
  const { ref, dir, command, signal } = options
  if (ref.platform !== 'github' || ref.host !== 'github.com')
    throw new Error('task 目前只支持 github.com')
  const spec = await readSpec(dir)
  const issueRef = `github:${ref.project}#${ref.iid}`
  if (spec.issue.ref !== issueRef)
    throw new Error(`spec.json 的 Issue 引用与任务参数不一致：需要 ${issueRef}`)
  const issuePath = join(dir, 'input', 'issue.md')
  if (!(await stat(issuePath, { throwIfNoEntry: false }))?.isFile())
    throw new Error('缺少 Issue 内容文件 input/issue.md')
  const env: Environment = { ...options.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' }
  const repo = join(dir, 'repo')
  const git = (args: string[]) => command(['git', ...args], { cwd: repo, env, signal })
  if (!(await stat(repo, { throwIfNoEntry: false }))?.isDirectory())
    throw new Error('缺少任务工作副本 repo')
  if ((await git(['rev-parse', '--is-inside-work-tree', '--show-prefix'])) !== 'true')
    throw new Error('repo 不是 Git 工作副本的根目录')
  if ((await git(['symbolic-ref', '--quiet', 'HEAD'])) !== `refs/heads/${spec.repo.branch}`)
    throw new Error(`任务工作副本未检出分支 ${spec.repo.branch}`)
  const now = options.now ?? (() => new Date())
  const secrets = [options.env.GH_TOKEN, options.env.WORKLING_LLM_API_KEY].filter(
    (value): value is string => Boolean(value),
  )
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`))
  const log = (line: string) => {
    line = redact(line, secrets)
    const ts = now()
    appendFileSync(
      join(dir, 'workling-events.jsonl'),
      `${JSON.stringify({ type: 'step', ts: ts.toISOString(), text: line })}\n`,
    )
    out(`[workling ${time(ts)}] ${line}`)
  }
  const outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true, mode: 0o700 })
  await chmod(outDir, 0o700)
  const llmBaseUrl = env.WORKLING_LLM_BASE_URL
  const piModel = spec.model.pi ?? spec.model.codex
  let piEnv: Environment = { ...options.env, GH_PROMPT_DISABLED: '1' }
  let modelArgs = spec.model.pi ? ['--model', spec.model.pi] : []
  if (llmBaseUrl) {
    const api = env.WORKLING_LLM_API ?? 'openai-responses'
    log(`生成模型配置（${api}，Pi 模型 workling/${piModel}）`)
    const piAgentDir = join(dir, 'pi-agent')
    const codexHome = join(dir, 'codex-home')
    await mkdir(piAgentDir, { recursive: true, mode: 0o700 })
    await mkdir(codexHome, { recursive: true, mode: 0o700 })
    await chmod(piAgentDir, 0o700)
    await chmod(codexHome, 0o700)
    const models = {
      providers: {
        workling: {
          baseUrl: llmBaseUrl,
          api,
          apiKey: '$WORKLING_LLM_API_KEY',
          models: [{ id: piModel, reasoning: true }],
        },
      },
    }
    await writeFile(join(piAgentDir, 'models.json'), `${JSON.stringify(models, null, 2)}\n`, {
      mode: 0o600,
    })
    await chmod(join(piAgentDir, 'models.json'), 0o600)
    const toml = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    const config = `model_provider = "workling"\nmodel = "${toml(spec.model.codex)}"\n\n[model_providers.workling]\nname = "workling"\nbase_url = "${toml(llmBaseUrl)}"\nwire_api = "${api === 'openai-completions' ? 'chat' : 'responses'}"\nenv_key = "WORKLING_LLM_API_KEY"\n`
    await writeFile(join(codexHome, 'config.toml'), config, { mode: 0o600 })
    await chmod(join(codexHome, 'config.toml'), 0o600)
    piEnv = {
      ...piEnv,
      PI_CODING_AGENT_DIR: piAgentDir,
      CODEX_HOME: codexHome,
    }
    modelArgs = ['--model', `workling/${piModel}`]
  }
  const instruction = `Issue：https://github.com/${ref.project}/issues/${ref.iid}（${issueRef}）
仓库目录：${repo}
任务分支：${spec.repo.branch}（已检出，基于 ${spec.repo.baseRef}）${spec.repo.docBranch ? `\n文档分支：${spec.repo.docBranch}` : ''}
任务目录：${dir}
Issue 内容：${issuePath}
默认 codex 模型：${spec.model.codex}
默认 codex 推理强度：${spec.model.effort}
codex 沙箱模式：${env.WORKLING_CODEX_SANDBOX ?? 'workspace-write'}
按系统提示中的 workling 工作约定完成这个 Issue。`
  // watch 对 task 进程组发出的信号需要同时到达 Pi。
  log('拉起 Pi')
  const started = now().getTime()
  const format = createPiEventFormatter({ secrets, now })
  const status = await (options.wait ?? streamProcess)(
    [
      ...(options.pi ?? ['node', PI_CLI]),
      '--print',
      '--mode',
      'json',
      '--no-approve',
      '--session-dir',
      join(dir, 'pi-session'),
      '--append-system-prompt',
      join(ROOT, 'configs/workling/AGENTS.md'),
      '--extension',
      join(ROOT, 'configs/workling/extensions/no-bash-timeout.ts'),
      ...modelArgs,
      '--',
      instruction,
    ],
    {
      cwd: repo,
      env: piEnv,
      signal,
      detached: false,
      onLine: (line) => {
        appendFileSync(join(dir, 'pi-events.jsonl'), `${line}\n`)
        for (const formatted of format(line)) out(formatted)
      },
    },
  )
  const finished = now()
  const durationMs = finished.getTime() - started
  appendFileSync(
    join(dir, 'workling-events.jsonl'),
    `${JSON.stringify({ type: 'pi_exit', ts: finished.toISOString(), code: status.code, signal: status.signal, durationMs })}\n`,
  )
  const elapsed = duration(durationMs)
  log(
    status.signal
      ? `Pi 被信号 ${status.signal} 结束，用时 ${elapsed}`
      : `Pi 结束：退出码 ${status.code}，用时 ${elapsed}`,
  )
  try {
    // Pi 即使因信号退出，也保留已经完成的本地提交和实际退出状态。
    const outputGit = (args: string[]) => command(['git', ...args], { cwd: repo, env })
    const { baseRef, branch } = spec.repo
    const ref = `refs/heads/${branch}`
    const range = `${baseRef}..${ref}`
    const count = await outputGit(['rev-list', '--count', range])
    const commits = Number(count)
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(commits)) throw new Error('提交数量无效')
    const bundle = join(outDir, 'commits.bundle')
    const head = await outputGit(['rev-parse', '--verify', ref])
    if (commits > 0) await outputGit(['bundle', 'create', bundle, range])
    else await rm(bundle, { force: true })
    const report = await readFile(join(dir, 'report.md'), 'utf8').catch(() => '')
    const result = reportResultLine(report)
    const outcome =
      result === '完成' ? 'completed' : result === '部分完成' ? 'partial' : 'incomplete'
    await writeOutResult(outDir, {
      contract: CONTRACT_VERSION,
      outcome,
      branch,
      head: head === baseRef ? null : head,
      commits,
    })
  } catch (cause) {
    const error = `生成任务产出失败：${redact(errorMessage(cause), secrets)}`
    log(error)
    return { ...status, error }
  }
  return status
}
