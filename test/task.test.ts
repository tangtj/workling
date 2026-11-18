import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseIssueRef } from '../src/issue/reference.ts'
import { CONTRACT_VERSION, writeSpec, type Spec } from '../src/contract/spec.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { isAlive } from '../src/runtime/process.ts'
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
  repo: { baseRef: 'a'.repeat(40), branch: 'workling/12-issue' },
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

async function prepareTask(dir: string, pi?: string, docBranch?: string) {
  await writeSpec(dir, {
    ...spec,
    model: { ...spec.model, ...(pi ? { pi } : {}) },
    repo: { ...spec.repo, ...(docBranch ? { docBranch } : {}) },
  })
  await mkdir(join(dir, 'input'))
  await writeFile(join(dir, 'input', 'issue.md'), '# 测试 Issue\n')
  await mkdir(join(dir, 'repo'))
  return dir
}

const preparedGit: Command = async (args) => {
  if (args[1] === 'rev-parse') return 'true'
  if (args[1] === 'symbolic-ref') return `refs/heads/${spec.repo.branch}`
  return ''
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

async function setupTask({ pi, docBranch }: { pi?: string; docBranch?: string } = {}) {
  const workspace = await temp()
  const dir = await prepareTask(await createTaskDir(workspace, ref), pi, docBranch)
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
    expect(args[0]).toBe('git')
    expect(options?.cwd).toBe(join(dir, 'repo'))
    return preparedGit(args, options)
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

test('runTask 使用已准备的工作副本，假 Pi 收到两个分支和正确环境并返回非零退出码', async () => {
  const options = await setupTask({ pi: 'test-provider/model', docBranch: 'docs/design' })
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
    `Issue：https://github.com/a/b/issues/12（github:a/b#12）\n仓库目录：${options.dir}/repo\n任务分支：${spec.repo.branch}（已检出，基于 ${spec.repo.baseRef}）\n文档分支：docs/design\n任务目录：${options.dir}\nIssue 内容：${options.dir}/input/issue.md\n默认 codex 模型：spec-codex\n默认 codex 推理强度：high\ncodex 沙箱模式：workspace-write\n按系统提示中的 workling 工作约定完成这个 Issue。`,
  ])
  expect(JSON.stringify(captured.args)).not.toContain('private-token')
  expect(captured.cwd).toBe(
    await import('node:fs/promises').then((fs) => fs.realpath(join(options.dir, 'repo'))),
  )
  expect(captured.env.GH_TOKEN).toBe('private-token')
  expect(captured.env.GH_PROMPT_DISABLED).toBe('1')
  expect(captured.env.GH_HOST).toBe('wrong')
  expect(options.calls).toEqual([
    ['git', 'rev-parse', '--is-inside-work-tree', '--show-prefix'],
    ['git', 'symbolic-ref', '--quiet', 'HEAD'],
    ['git', 'config', '--local', 'credential.helper', ''],
    ['git', 'config', '--local', '--add', 'credential.helper', '!gh auth git-credential'],
  ])
})

test('runTask 使用指定的 Pi 模型和默认入口，拒绝不支持的引用', async () => {
  const base = {
    ref,
    dir: await prepareTask(await temp(), 'provider/model'),
    env: {},
    signal: new AbortController().signal,
    command: preparedGit,
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
})

test.each([
  ['工作副本缺失', undefined, undefined, '缺少任务工作副本 repo'],
  ['裸仓库', 'false', undefined, 'repo 不是 Git 工作副本的根目录'],
  ['父目录是工作副本', 'true\nrepo/', undefined, 'repo 不是 Git 工作副本的根目录'],
  ['分支不符', 'true', 'refs/heads/other', '任务工作副本未检出分支 workling/12-issue'],
] as const)('runTask 在%s时不配置凭证也不拉起 Pi', async (_kind, workTree, branch, error) => {
  const options = await setupTask()
  if (workTree === undefined) await rm(join(options.dir, 'repo'), { recursive: true })
  await expect(
    runTask({
      ...options,
      command: async (args) => {
        if (args[1] === 'rev-parse' && workTree !== undefined) return workTree
        if (args[1] === 'symbolic-ref' && branch !== undefined) return branch
        throw new Error('不应执行的 Git 命令')
      },
      wait: async () => {
        throw new Error('不应拉起 Pi')
      },
    }),
  ).rejects.toThrow(error)
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
] as const)('runTask 在%s时不调用 Git 或 Pi', async (_kind, raw, input, error) => {
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
        throw new Error('不应调用 Git')
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
      command: preparedGit,
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
  expect(launchArgs.at(-1)).toContain(
    `任务分支：${spec.repo.branch}（已检出，基于 ${spec.repo.baseRef}）`,
  )
  expect(launchArgs.at(-1)).not.toContain('文档分支：')
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
    'git switch -c',
    'git fetch --depth',
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
    '[workling 00:00:00] 配置 git 凭证',
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
      command: preparedGit,
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
      { type: 'pi_exit', ts: new Date(3000).toISOString(), ...status, durationMs: 1000 },
    ])
  }
})
