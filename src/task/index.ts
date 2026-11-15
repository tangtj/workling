import { appendFileSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IssueRef } from '../issue/reference.ts'
import { CLI, PI_CLI, ROOT } from '../runtime/paths.ts'
import { streamProcess } from '../runtime/process.ts'
import { createPiEventFormatter, duration, time } from '../task/pi-events.ts'
import type { Command, Environment, ExitStatus } from '../runtime/types.ts'

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
}): Promise<ExitStatus> {
  const { ref, dir, command, signal } = options
  if (ref.platform !== 'github' || ref.host !== 'github.com')
    throw new Error('task 目前只支持 github.com')
  const env: Environment = { ...options.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' }
  const now = options.now ?? (() => new Date())
  const secrets = [options.env.GH_TOKEN, options.env.WORKLING_LLM_API_KEY].filter(
    (value): value is string => Boolean(value),
  )
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`))
  const log = (line: string) => {
    const ts = now()
    appendFileSync(
      join(dir, 'workling-events.jsonl'),
      `${JSON.stringify({ type: 'step', ts: ts.toISOString(), text: line })}\n`,
    )
    let formatted = `[workling ${time(ts)}] ${line}`
    for (const secret of secrets) formatted = formatted.replaceAll(secret, '***')
    out(formatted)
  }
  const repo = join(dir, 'repo')
  log(`克隆 ${ref.project}`)
  await command(['gh', 'repo', 'clone', ref.project, repo, '--', '--depth', '50'], { env, signal })
  log('配置 git 凭证与提交身份')
  for (const args of [
    // 浅克隆只跟踪默认分支，push 后缺少 origin/<分支> 会使 gh pr create 误判未推送。
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['credential.helper', ''],
    ['--add', 'credential.helper', '!gh auth git-credential'],
    ['user.name', env.WORKLING_GIT_NAME!],
    ['user.email', env.WORKLING_GIT_EMAIL!],
  ]) {
    await command(['git', 'config', '--local', ...args], { cwd: repo, env, signal })
  }
  const llmBaseUrl = env.WORKLING_LLM_BASE_URL
  const piModel = env.WORKLING_PI_MODEL ?? env.WORKLING_MODEL
  let piEnv: Environment = { ...options.env, GH_PROMPT_DISABLED: '1' }
  let modelArgs = env.WORKLING_PI_MODEL ? ['--model', env.WORKLING_PI_MODEL] : []
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
    const config = `model_provider = "workling"\nmodel = "${toml(env.WORKLING_MODEL ?? '')}"\n\n[model_providers.workling]\nname = "workling"\nbase_url = "${toml(llmBaseUrl)}"\nwire_api = "${api === 'openai-completions' ? 'chat' : 'responses'}"\nenv_key = "WORKLING_LLM_API_KEY"\n`
    await writeFile(join(codexHome, 'config.toml'), config, { mode: 0o600 })
    await chmod(join(codexHome, 'config.toml'), 0o600)
    piEnv = {
      ...piEnv,
      PI_CODING_AGENT_DIR: piAgentDir,
      CODEX_HOME: codexHome,
    }
    modelArgs = ['--model', `workling/${piModel}`]
  }
  const instruction = `Issue：https://github.com/${ref.project}/issues/${ref.iid}（github:${ref.project}#${ref.iid}）
仓库目录：${repo}
任务目录：${dir}
默认 codex 模型：${env.WORKLING_MODEL}
默认 codex 推理强度：${env.WORKLING_EFFORT}
codex 沙箱模式：${env.WORKLING_CODEX_SANDBOX ?? 'workspace-write'}
workling 命令：bun ${CLI}
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
  return status
}
