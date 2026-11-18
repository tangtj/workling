import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseIssueRef } from '../src/issue/reference.ts'
import { CONTRACT_VERSION, writeSpec, type Spec } from '../src/contract/spec.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { isAlive, run } from '../src/runtime/process.ts'
import type { Command, Environment } from '../src/runtime/types.ts'
import {
  assertTaskDir,
  createTaskDir,
  readResult,
  taskDirName,
  writeResult,
} from '../src/task/dir.ts'
import { runTask } from '../src/task/index.ts'

const ref = parseIssueRef('github:a/b#12')
const spec: Spec = {
  contract: CONTRACT_VERSION,
  kind: 'implement',
  issue: { ref: 'github:a/b#12', title: '测试 Issue' },
  model: { codex: 'spec-codex', effort: 'high' },
  git: { name: 'spec-bot', email: 'spec-bot@example.com' },
}
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'workling-task-'))
  dirs.push(dir)
  return dir
}

async function prepareTask(dir: string, pi?: string) {
  await writeSpec(dir, { ...spec, model: { ...spec.model, ...(pi ? { pi } : {}) } })
  await mkdir(join(dir, 'input'))
  await writeFile(join(dir, 'input', 'issue.md'), '# 测试 Issue\n')
  return dir
}

async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error('等待超时')
}

test('任务目录名使用 UTC，创建权限 0700 且拒绝重名和非法目录层级', async () => {
  const workspace = await temp()
  const now = new Date('2026-11-14T10:30:00Z')
  expect(taskDirName(ref, now)).toBe('a-b-12-20261114T103000Z')
  const dir = await createTaskDir(workspace, ref, now)
  expect(dir).toBe(join(workspace, 'tasks', taskDirName(ref, now)))
  expect((await stat(dir)).mode & 0o777).toBe(0o700)
  expect((await stat(join(workspace, 'tasks'))).mode & 0o777).toBe(0o700)
  await expect(createTaskDir(workspace, ref, now)).rejects.toThrow()
  expect(assertTaskDir(workspace, dir)).toBe(dir)
  for (const path of [
    workspace,
    join(workspace, 'tasks'),
    join(dir, 'sub'),
    join(dir, '../..'),
    '/tmp/outside',
  ])
    expect(() => assertTaskDir(workspace, path)).toThrow()
})

test('result 原子写入后正常往返，缺失、半截 JSON 和错误形状分别返回约定结果', async () => {
  const dir = await temp()
  expect(await readResult(dir)).toBeUndefined()
  const result = { exitCode: 7, signal: null, finishedAt: new Date().toISOString() }
  await writeResult(dir, result)
  expect(await readResult(dir)).toEqual(result)
  expect(await Bun.file(join(dir, 'result.json.tmp')).exists()).toBe(false)
  for (const raw of ['{"exitCode":', '{}', '{"exitCode":"0","signal":null,"finishedAt":"today"}']) {
    await writeFile(join(dir, 'result.json'), raw)
    expect(await readResult(dir)).toBe('invalid')
  }
  const failed = {
    exitCode: null,
    signal: 'SIGTERM',
    finishedAt: result.finishedAt,
    error: '克隆失败',
  }
  await writeResult(dir, failed)
  expect(await readResult(dir)).toEqual(failed)
})

async function setupTask({ pi, realGit = false }: { pi?: string; realGit?: boolean } = {}) {
  const workspace = await temp()
  const bare = join(workspace, 'source.git')
  if (realGit) await run(['git', 'init', '--bare', bare])
  const dir = await prepareTask(await createTaskDir(workspace, ref), pi)
  const record = join(dir, 'pi.json')
  const env: Environment = {
    ...process.env,
    GH_TOKEN: 'private-token',
    GH_HOST: 'wrong',
    WORKLING_MODEL: 'stale-codex',
    WORKLING_EFFORT: 'low',
    WORKLING_GIT_NAME: 'stale-bot',
    WORKLING_GIT_EMAIL: 'stale-bot@example.com',
    WORKLING_PI_MODEL: 'stale-pi',
    WORKLING_TEST_RECORD: record,
  }
  const calls: string[][] = []
  const command: Command = async (args, options) => {
    calls.push(args)
    expect(options?.env).toEqual({ ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' })
    if (args[0] === 'gh') {
      expect(args).toEqual(['gh', 'repo', 'clone', 'a/b', join(dir, 'repo'), '--', '--depth', '50'])
      if (realGit) return run(['git', 'clone', bare, args[4]!], options)
      await mkdir(join(dir, 'repo'))
      return ''
    }
    return realGit ? run(args, options) : ''
  }
  return {
    dir,
    record,
    env,
    command,
    calls,
    ref,
    signal: new AbortController().signal,
    pi: [process.execPath, resolve('test/fixtures/pi.ts')],
  }
}

test('runTask 真实克隆和配置 Git，假 Pi 收到精确参数、指令和环境并返回非零退出码', async () => {
  const options = await setupTask({ pi: 'test-provider/model', realGit: true })
  options.env.WORKLING_TEST_EXIT = '7'
  const status = await runTask(options)
  expect(status).toEqual({ code: 7, signal: null })
  const captured = JSON.parse(await readFile(options.record, 'utf8'))
  expect(captured.args).toEqual([
    '--print',
    '--mode',
    'json',
    '--no-approve',
    '--session-dir',
    join(options.dir, 'pi-session'),
    '--append-system-prompt',
    join(ROOT, 'configs/workling/AGENTS.md'),
    '--extension',
    join(ROOT, 'configs/workling/extensions/no-bash-timeout.ts'),
    '--model',
    'test-provider/model',
    '--',
    `Issue：https://github.com/a/b/issues/12（github:a/b#12）\n仓库目录：${options.dir}/repo\n任务目录：${options.dir}\nIssue 内容：${options.dir}/input/issue.md\n默认 codex 模型：spec-codex\n默认 codex 推理强度：high\ncodex 沙箱模式：workspace-write\n按系统提示中的 workling 工作约定完成这个 Issue。`,
  ])
  expect(JSON.stringify(captured.args)).not.toContain('private-token')
  expect(captured.cwd).toBe(
    await import('node:fs/promises').then((fs) => fs.realpath(join(options.dir, 'repo'))),
  )
  expect(captured.env.GH_TOKEN).toBe('private-token')
  expect(captured.env.GH_PROMPT_DISABLED).toBe('1')
  expect(captured.env.GH_HOST).toBe('wrong')
  expect(options.calls.slice(1)).toEqual([
    ['git', 'config', '--local', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['git', 'config', '--local', 'credential.helper', ''],
    ['git', 'config', '--local', '--add', 'credential.helper', '!gh auth git-credential'],
    ['git', 'config', '--local', 'user.name', 'spec-bot'],
    ['git', 'config', '--local', 'user.email', 'spec-bot@example.com'],
  ])
  const git = (key: string) =>
    run(['git', 'config', '--local', '--get-all', key], { cwd: join(options.dir, 'repo') })
  expect(await git('remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*')
  expect(await git('credential.helper')).toBe('!gh auth git-credential')
  expect(await git('user.name')).toBe('spec-bot')
  expect(await git('user.email')).toBe('spec-bot@example.com')
})

test('浅克隆配置全部分支后推送新分支会建立远端跟踪引用', async () => {
  const workspace = await temp()
  const bare = join(workspace, 'source.git')
  const seed = join(workspace, 'seed')
  const repo = join(workspace, 'clone')
  await run(['git', 'init', '--bare', bare])
  await run(['git', 'clone', bare, seed])
  const seedOptions = { cwd: seed }
  await run(['git', 'config', '--local', 'user.name', 'workling'], seedOptions)
  await run(['git', 'config', '--local', 'user.email', 'workling@example.com'], seedOptions)
  for (let i = 0; i < 51; i++)
    await run(['git', 'commit', '--allow-empty', '-m', `Seed commit ${i}`], seedOptions)
  await run(['git', 'push', 'origin', 'HEAD'], seedOptions)
  await run(['git', 'clone', '--depth', '50', `file://${bare}`, repo])
  const options = { cwd: repo }
  expect(await run(['git', 'rev-parse', '--is-shallow-repository'], options)).toBe('true')
  expect(await run(['git', 'rev-list', '--count', 'HEAD'], options)).toBe('50')
  await run(
    ['git', 'config', '--local', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    options,
  )
  await run(['git', 'config', '--local', 'user.name', 'workling'], options)
  await run(['git', 'config', '--local', 'user.email', 'workling@example.com'], options)
  await run(['git', 'checkout', '-b', 'task-branch'], options)
  await run(['git', 'commit', '--allow-empty', '-m', 'Task commit'], options)
  await run(['git', 'push', '-u', 'origin', 'HEAD'], options)
  expect(await run(['git', 'rev-parse', '--symbolic-full-name', '@{push}'], options)).toBe(
    'refs/remotes/origin/task-branch',
  )
})

test('runTask 可选 Pi 模型与默认入口符合规格，拒绝不支持的引用并透传克隆失败', async () => {
  const base = {
    ref,
    dir: await prepareTask(await temp(), 'provider/model'),
    env: {},
    signal: new AbortController().signal,
    command: async () => '',
  }
  await runTask({
    ...base,
    wait: async (args, options) => {
      expect(options?.detached).toBe(false)
      expect(args.slice(0, 2)).toEqual([
        'node',
        join(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
      ])
      expect(args.slice(-4, -2)).toEqual(['--model', 'provider/model'])
      return { code: 0, signal: null }
    },
  })
  for (const other of [{ ...ref, host: 'enterprise.example' }, parseIssueRef('gitlab:a/b#12')])
    await expect(runTask({ ...base, ref: other })).rejects.toThrow('task 目前只支持 github.com')
  await expect(
    runTask({
      ...base,
      command: async () => {
        throw new Error('克隆失败')
      },
    }),
  ).rejects.toThrow('克隆失败')
})

test.each([
  ['缺少契约', undefined, true, '缺少 spec.json'],
  ['契约无效', '{}', true, 'spec.json 的结构无效'],
  [
    '引用不一致',
    JSON.stringify({ ...spec, issue: { ...spec.issue, ref: 'github:a/b#13' } }),
    true,
    'Issue 引用与任务参数不一致',
  ],
  ['缺少内容', JSON.stringify(spec), false, '缺少 Issue 内容文件 input/issue.md'],
] as const)('runTask 在%s时不克隆也不拉起 Pi', async (_kind, raw, input, error) => {
  const dir = await temp()
  if (raw !== undefined) await writeFile(join(dir, 'spec.json'), raw)
  if (input) {
    await mkdir(join(dir, 'input'))
    await writeFile(join(dir, 'input', 'issue.md'), '# 测试 Issue\n')
  }
  await expect(
    runTask({
      ref,
      dir,
      env: {},
      signal: new AbortController().signal,
      command: async () => {
        throw new Error('不应克隆')
      },
      wait: async () => {
        throw new Error('不应拉起 Pi')
      },
    }),
  ).rejects.toThrow(error)
})

test.each([undefined, 'danger-full-access'])(
  '任务指令的 codex 沙箱模式使用配置或默认 workspace-write：%s',
  async (sandbox) => {
    await runTask({
      ref,
      dir: await prepareTask(await temp()),
      command: async () => '',
      env: { WORKLING_CODEX_SANDBOX: sandbox },
      signal: new AbortController().signal,
      wait: async (args) => {
        expect(args.at(-1)).toContain(
          `默认 codex 推理强度：high\ncodex 沙箱模式：${sandbox ?? 'workspace-write'}\n`,
        )
        return { code: 0, signal: null }
      },
    })
  },
)

test('runTask 自定义接口生成受限配置且密钥只经环境变量传递', async () => {
  const options = await setupTask({ pi: 'custom/pi-model' })
  const fakeKey = 'distinctive-fake-key-9f2c'
  options.env.WORKLING_LLM_BASE_URL = 'https://llm.example/v1\\path"quoted'
  options.env.WORKLING_LLM_API_KEY = fakeKey
  options.env.WORKLING_LLM_API = 'openai-completions'
  let launchArgs: string[] = []
  let launchEnv: Environment | undefined
  await runTask({
    ...options,
    wait: async (args, waitOptions) => {
      launchArgs = args
      launchEnv = waitOptions?.env
      return { code: 0, signal: null }
    },
  })
  const piDir = join(options.dir, 'pi-agent')
  const codexDir = join(options.dir, 'codex-home')
  const modelsPath = join(piDir, 'models.json')
  const configPath = join(codexDir, 'config.toml')
  const modelsText = await readFile(modelsPath, 'utf8')
  const configText = await readFile(configPath, 'utf8')
  expect(modelsText).toBe(
    `${JSON.stringify(
      {
        providers: {
          workling: {
            baseUrl: 'https://llm.example/v1\\path"quoted',
            api: 'openai-completions',
            apiKey: '$WORKLING_LLM_API_KEY',
            models: [{ id: 'custom/pi-model', reasoning: true }],
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  expect(configText).toBe(
    `model_provider = "workling"\nmodel = "spec-codex"\n\n[model_providers.workling]\nname = "workling"\nbase_url = "https://llm.example/v1\\\\path\\"quoted"\nwire_api = "chat"\nenv_key = "WORKLING_LLM_API_KEY"\n`,
  )
  expect(modelsText).not.toContain(fakeKey)
  expect(configText).not.toContain(fakeKey)
  expect((await stat(piDir)).mode & 0o777).toBe(0o700)
  expect((await stat(codexDir)).mode & 0o777).toBe(0o700)
  expect((await stat(modelsPath)).mode & 0o777).toBe(0o600)
  expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  expect(launchArgs.slice(-4, -2)).toEqual(['--model', 'workling/custom/pi-model'])
  expect(launchArgs.at(-1)).toContain(`Issue 内容：${join(options.dir, 'input', 'issue.md')}`)
  expect(launchArgs.at(-1)).toContain('默认 codex 模型：spec-codex\n默认 codex 推理强度：high')
  expect(launchArgs.at(-1)).not.toContain('workling 命令')
  expect(options.calls.slice(-2)).toEqual([
    ['git', 'config', '--local', 'user.name', 'spec-bot'],
    ['git', 'config', '--local', 'user.email', 'spec-bot@example.com'],
  ])
  expect(launchArgs.join(' ')).not.toContain(fakeKey)
  expect(launchEnv).toMatchObject({
    PI_CODING_AGENT_DIR: piDir,
    CODEX_HOME: codexDir,
    WORKLING_LLM_API_KEY: fakeKey,
  })
})

test('runTask 自定义接口的 Pi 模型回退至契约中的 codex 模型，未配置时保持原行为', async () => {
  const configured = await setupTask()
  configured.env.WORKLING_LLM_BASE_URL = 'http://localhost:8080/v1/'
  configured.env.WORKLING_LLM_API_KEY = 'distinctive-fake-key'
  let args: string[] = []
  await runTask({
    ...configured,
    wait: async (value) => {
      args = value
      return { code: 0, signal: null }
    },
  })
  expect(args.slice(-4, -2)).toEqual(['--model', 'workling/spec-codex'])

  const normal = await setupTask()
  let normalArgs: string[] = []
  let normalEnv: Environment | undefined
  await runTask({
    ...normal,
    wait: async (value, waitOptions) => {
      normalArgs = value
      normalEnv = waitOptions?.env
      return { code: 0, signal: null }
    },
  })
  expect(normalArgs).not.toContain('--model')
  expect(normalEnv).not.toHaveProperty('PI_CODING_AGENT_DIR')
  expect(normalEnv).not.toHaveProperty('CODEX_HOME')
  expect(await Bun.file(join(normal.dir, 'pi-agent/models.json')).exists()).toBe(false)
  expect(await Bun.file(join(normal.dir, 'codex-home/config.toml')).exists()).toBe(false)
})

test('runTask 中止时结束假 Pi 与其子进程并返回信号', async () => {
  const options = await setupTask()
  const controller = new AbortController()
  options.env.WORKLING_TEST_SLEEP = '1'
  const pending = runTask({ ...options, signal: controller.signal })
  try {
    await until(() => Bun.file(options.record).exists())
    const captured = JSON.parse(await readFile(options.record, 'utf8'))
    expect(isAlive(captured.pid)).toBe(true)
    expect(isAlive(captured.child)).toBe(true)
    controller.abort()
    expect(await pending).toEqual({ code: null, signal: 'SIGTERM' })
    await until(() => !isAlive(captured.pid) && !isAlive(captured.child))
  } finally {
    controller.abort()
    await pending
  }
})

test('Pi 工作约定使用本地 Issue 和附件路径', async () => {
  const prompt = await readFile(join(ROOT, 'configs/workling/AGENTS.md'), 'utf8')
  expect(prompt).toContain('<任务目录>/input/issue.md')
  expect(prompt).toContain('<任务目录>/input/attachments/')
  for (const removed of [
    'workling 命令',
    'read <Issue 引用>',
    '<任务目录>/issue.md',
    '<任务目录>/attachments/',
  ])
    expect(prompt).not.toContain(removed)
})

test('runTask 保存原始事件并输出脱敏的步骤与 Pi 进度', async () => {
  const options = await setupTask()
  const raw = `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'private-token' }] } })}\n`
  options.env.WORKLING_TEST_EVENTS = raw
  const lines: string[] = []
  await runTask({ ...options, out: (line) => lines.push(line), now: () => new Date(2026, 0, 1) })
  expect(await readFile(join(options.dir, 'pi-events.jsonl'), 'utf8')).toBe(raw)
  expect(lines).toEqual([
    '[workling 00:00:00] 克隆 a/b',
    '[workling 00:00:00] 配置 git 凭证与提交身份',
    '[workling 00:00:00] 拉起 Pi',
    '[pi 00:00:00] ***',
    '[workling 00:00:00] Pi 结束：退出码 0，用时 0 秒',
  ])
})

test('workling-events 写入全部 step 与 pi_exit，保留退出码和信号及耗时', async () => {
  for (const status of [
    { code: 7, signal: null },
    { code: null, signal: 'SIGTERM' as const },
  ]) {
    const dir = await prepareTask(await temp())
    let clock = 0
    const lines: string[] = []
    const result = await runTask({
      ref,
      dir,
      command: async () => '',
      env: {},
      signal: new AbortController().signal,
      out: (line) => lines.push(line),
      now: () => new Date(clock++ * 1000),
      wait: async () => status,
    })
    const events = (await readFile(join(dir, 'workling-events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(result).toEqual(status)
    expect(events.filter((e) => e.type === 'step').map((e) => e.text)).toEqual(
      lines.map((line) => line.replace(/^\[workling [\d:]+\] /, '')),
    )
    expect(events.filter((e) => e.type === 'pi_exit')).toEqual([
      { type: 'pi_exit', ts: new Date(4000).toISOString(), ...status, durationMs: 1000 },
    ])
  }
})
