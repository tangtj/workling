import { appendFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readPiOutcome, writeOutResult } from '../src/contract/out.ts'
import { readLlmSecrets } from '../src/contract/secrets.ts'
import { CONTRACT_VERSION, readSpec } from '../src/contract/spec.ts'
import { createPiEventFormatter, duration, time } from './pi-events.ts'
import {
  errorMessage,
  streamProcess,
  type Command,
  type Environment,
  type ExitStatus,
} from './process.ts'
import { redact, reportOutcome } from '../src/contract/report.ts'

const PI_CLI = resolve(
  import.meta.dirname,
  '../node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
)

export async function runTask(options: {
  ref: string
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
  const match = /^github:([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(ref)
  if (!match) throw new Error('task 目前只支持 github.com')
  const [issueRef, project, iid] = [match[0], match[1]!, match[2]!]
  const spec = await readSpec(dir)
  if (spec.issue.ref !== issueRef)
    throw new Error(`spec.json 的 Issue 引用与任务参数不一致：需要 ${issueRef}`)
  const issuePath = join(dir, 'input', 'issue.md')
  if (!(await stat(issuePath, { throwIfNoEntry: false }))?.isFile())
    throw new Error('缺少 Issue 内容文件 input/issue.md')
  const llmSecrets = await readLlmSecrets(dir)
  const { env } = options
  const repo = join(dir, 'repo')
  const git = (args: string[]) => command(['git', ...args], { cwd: repo, env, signal })
  if (!(await stat(repo, { throwIfNoEntry: false }))?.isDirectory())
    throw new Error('缺少任务工作副本 repo')
  if ((await git(['rev-parse', '--is-inside-work-tree', '--show-prefix'])) !== 'true')
    throw new Error('repo 不是 Git 工作副本的根目录')
  if ((await git(['symbolic-ref', '--quiet', 'HEAD'])) !== `refs/heads/${spec.repo.branch}`)
    throw new Error(`任务工作副本未检出分支 ${spec.repo.branch}`)
  const now = options.now ?? (() => new Date())
  const secrets = llmSecrets ? [llmSecrets.apiKey] : []
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
  const piModel = spec.model.pi ?? spec.model.codex
  const piEnv = { ...env }
  // 手动运行旧命令时，仍不把平台凭证或旧的 LLM Key 传给 Pi。
  for (const name of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'WORKLING_LLM_API_KEY',
  ])
    delete piEnv[name]
  let modelArgs = spec.model.pi ? ['--model', spec.model.pi] : []
  if (llmSecrets) {
    const { baseUrl, apiKey, api } = llmSecrets
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
          baseUrl,
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
    const config = `model_provider = "workling"\nmodel = "${toml(spec.model.codex)}"\n\n[model_providers.workling]\nname = "workling"\nbase_url = "${toml(baseUrl)}"\nwire_api = "${api === 'openai-completions' ? 'chat' : 'responses'}"\nenv_key = "WORKLING_LLM_API_KEY"\n`
    await writeFile(join(codexHome, 'config.toml'), config, { mode: 0o600 })
    await chmod(join(codexHome, 'config.toml'), 0o600)
    piEnv.PI_CODING_AGENT_DIR = piAgentDir
    piEnv.CODEX_HOME = codexHome
    piEnv.WORKLING_LLM_API_KEY = apiKey
    modelArgs = ['--model', `workling/${piModel}`]
  }
  const branchStatus = spec.repo.continued
    ? `接续此前运行的工作分支，当前末端 ${spec.repo.baseRef}`
    : `基于 ${spec.repo.baseRef}`
  const instruction = `Issue：https://github.com/${project}/issues/${iid}（${issueRef}）
仓库目录：${repo}
任务分支：${spec.repo.branch}（已检出，${branchStatus}）${spec.repo.docBranch ? `\n文档分支：${spec.repo.docBranch}` : ''}
运行类型：${spec.kind}
任务目录：${dir}
Issue 内容：${issuePath}
上下文：${join(dir, 'input', 'runs.md')}、branch.md、pr.md、docs.md、feedback.md（workling 生成：历次运行、工作分支、PR 反馈、文档清单）
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
      join(import.meta.dirname, 'configs/AGENTS.md'),
      '--extension',
      join(import.meta.dirname, 'configs/extensions/no-bash-timeout.ts'),
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
    const report = await readFile(join(dir, 'report.md'), 'utf8').catch(() => '')
    const outcome = (await readPiOutcome(outDir)) ?? reportOutcome(report)
    if (commits > 0 && outcome !== 'answered') await outputGit(['bundle', 'create', bundle, range])
    else await rm(bundle, { force: true })
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
