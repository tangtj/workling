import {
  parseExecutorSettings,
  readExecutorSettings,
  updateExecutorSettings,
} from '../src/config/executor.ts'
import { eq } from 'drizzle-orm'
import type { StartSpec } from '../src/executor/index.ts'
import { expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readSpec } from '../src/contract/spec.ts'
import { issues, repos, runs } from '../src/db/schema.ts'
import { parsePiSettings, readPiSettings, updatePiSettings } from '../src/config/pi.ts'
import { launchQueued } from '../src/serve/launch.ts'
import { fakeExecutor, clock, scenario } from './helpers/serve.ts'

test('拉起按空闲名额与 Issue、仓库顺序调度，跳过 GHES 不占名额，参数环境和库标签一致', async () => {
  const s = await scenario()
  try {
    await s.issue(100, 'running')
    await s.issue(101, 'running')
    const remote = s.db
      .insert(repos)
      .values({
        ...s.repo,
        id: undefined,
        ref: 'github:a/remote',
        path: 'a/remote',
        host: 'git.example',
      })
      .returning()
      .get()
    const second = s.db
      .insert(repos)
      .values({ ...s.repo, id: undefined, ref: 'github:a/c', path: 'a/c' })
      .returning()
      .get()
    const disabled = s.db
      .insert(repos)
      .values({ ...s.repo, id: undefined, ref: 'github:a/off', path: 'a/off', enabled: false })
      .returning()
      .get()
    const gitlab = s.db
      .insert(repos)
      .values({ ...s.repo, id: undefined, ref: 'gitlab:a/b', platform: 'gitlab' })
      .returning()
      .get()
    await s.issue(1, 'queued', remote.id)
    await s.issue(1, 'queued', disabled.id)
    await s.issue(1, 'queued', gitlab.id)
    await s.issue(5, 'queued')
    await s.issue(2, 'queued', second.id)
    const first = await s.issue(2, 'queued')
    const launched: StartSpec[] = []
    const pi = parsePiSettings({
      model: 'configured-model',
      effort: 'high',
      piModel: 'pi-model',
      gitName: 'configured-name',
      gitEmail: 'configured@example.com',
    })
    await launchQueued({
      ...s.options,
      pi,
      executor: fakeExecutor({
        async start(spec) {
          launched.push(spec)
          const dir = spec.taskDir
          expect(spec).toMatchObject({ runId: 1, ref: 'github:a/b#2', taskDir: dir })
          expect(JSON.stringify({ ...spec, env: undefined })).not.toContain('repo-secret')
          expect(spec.env).toMatchObject({
            GH_TOKEN: 'repo-secret',
            GH_HOST: 'github.com',
            GH_PROMPT_DISABLED: '1',
            WORKLING_WORKSPACE: s.workspace,
          })
          expect(await readSpec(dir)).toEqual({
            contract: 1,
            kind: 'implement',
            issue: { ref: 'github:a/b#2', title: '测试 Issue' },
            model: { codex: pi.model, effort: pi.effort, pi: 'pi-model' },
            git: { name: pi.gitName, email: pi.gitEmail },
          })
          expect(await readFile(join(dir, 'input', 'issue.md'), 'utf8')).toContain('测试正文')
          return { pid: 876 }
        },
      }),
    })
    expect(launched).toHaveLength(1)
    expect(s.db.select().from(issues).where(eq(issues.id, first.id)).get()).toMatchObject({
      status: 'running',
      lastRunId: 1,
    })
    expect(s.db.select().from(runs).get()).toMatchObject({
      pid: 876,
      worker: 'worker',
      startedAt: clock,
    })
    expect(s.calls[0]?.args.slice(0, 6)).toEqual(['gh', 'issue', 'view', '2', '-R', 'a/b'])
    expect(s.calls[0]?.options?.env).toMatchObject({
      GH_TOKEN: 'repo-secret',
      GH_HOST: 'github.com',
    })
    expect(s.calls[1]!.args).toEqual([
      'gh',
      'issue',
      'edit',
      '2',
      '-R',
      'a/b',
      '--remove-label',
      'workling:queued',
      '--add-label',
      'workling:running',
    ])
    expect(s.calls[2]!.args).toEqual([
      'gh',
      'issue',
      'comment',
      '2',
      '-R',
      'a/b',
      '--body-file',
      '-',
    ])
    expect(s.calls[2]!.options?.input).toBe(
      `workling：已领取，开始执行。\n\n- 机器：worker\n- 开始时间：${clock.toISOString()}\n- 任务目录：${launched[0]!.taskDir}`,
    )
    expect(s.logs.some((line) => line.includes('跳过'))).toBe(true)
    await launchQueued({
      ...s.options,
      executor: fakeExecutor({
        async start() {
          throw new Error('无名额不应拉起')
        },
      }),
    })
    expect(s.db.select().from(runs).all()).toHaveLength(1)
  } finally {
    await s.dispose()
  }
})

test('拉起时仅传递已配置的 LLM 接入变量，旧模型和 Git 环境变量不传入 task', async () => {
  const configured = await scenario()
  try {
    await configured.issue(42, 'queued')
    let spec: StartSpec | undefined
    let env: NodeJS.ProcessEnv | undefined
    await launchQueued({
      ...configured.options,
      pi: parsePiSettings({
        llmBaseUrl: 'https://llm.example/v1',
        llmApiKey: 'distinctive-fake-key',
        llmApi: 'openai-completions',
      }),
      executor: fakeExecutor({
        async start(value) {
          spec = value
          env = value.env
          return { pid: 700 }
        },
      }),
    })
    expect(env).toMatchObject({
      WORKLING_LLM_BASE_URL: 'https://llm.example/v1',
      WORKLING_LLM_API_KEY: 'distinctive-fake-key',
      WORKLING_LLM_API: 'openai-completions',
    })
    expect(JSON.stringify({ ...spec, env: undefined })).not.toContain('distinctive-fake-key')
  } finally {
    await configured.dispose()
  }
  const unset = await scenario()
  try {
    const removed = [
      'WORKLING_MODEL',
      'WORKLING_EFFORT',
      'WORKLING_GIT_NAME',
      'WORKLING_GIT_EMAIL',
      'WORKLING_PI_MODEL',
      'WORKLING_LLM_BASE_URL',
      'WORKLING_LLM_API_KEY',
      'WORKLING_LLM_API',
    ]
    for (const name of removed) process.env[name] = 'stale-value'
    await unset.issue(42, 'queued')
    let env: NodeJS.ProcessEnv | undefined
    await launchQueued({
      ...unset.options,
      executor: fakeExecutor({
        async start(spec) {
          env = spec.env
          return { pid: 701 }
        },
      }),
    })
    expect(env).toBeDefined()
    for (const name of removed) expect(env).not.toHaveProperty(name)
  } finally {
    await unset.dispose()
  }
})

test('读取 Issue 失败时记录拉起失败并保持 queued，不调用执行器或更新平台', async () => {
  const s = await scenario()
  try {
    await s.issue(42, 'queued')
    let starts = 0
    await launchQueued({
      ...s.options,
      command: async (args, options) => {
        await s.options.command(args, options)
        if (args[2] === 'view') throw new Error('Issue 读取失败')
        return ''
      },
      executor: fakeExecutor({
        async start() {
          starts++
          return { pid: 123 }
        },
      }),
    })
    expect(starts).toBe(0)
    expect(s.calls.map((call) => call.args[2])).toEqual(['view'])
    expect(s.db.select().from(runs).get()).toMatchObject({
      error: '拉起失败：Issue 读取失败',
      endedAt: clock,
      pid: null,
    })
    expect(s.db.select().from(issues).get()).toMatchObject({ status: 'queued', lastRunId: null })
  } finally {
    await s.dispose()
  }
})

test('拉起失败记录原因和结束时间且保持 queued，下轮重试，标签失败不回滚成功', async () => {
  const s = await scenario()
  try {
    await s.issue(42, 'queued')
    await launchQueued({
      ...s.options,
      executor: fakeExecutor({
        async start() {
          throw new Error('spawn error')
        },
      }),
    })
    expect(s.db.select().from(runs).get()).toMatchObject({
      error: '拉起失败：spawn error',
      endedAt: clock,
      pid: null,
    })
    expect(s.db.select().from(issues).get()).toMatchObject({ status: 'queued', lastRunId: null })
    expect(s.calls.map((call) => call.args[2])).toEqual(['view'])
    await launchQueued({
      ...s.options,
      now: () => new Date(clock.getTime() + 1000),
      executor: fakeExecutor({
        async start(spec) {
          expect((await readSpec(spec.taskDir)).model).not.toHaveProperty('pi')
          return { pid: 99 }
        },
      }),
      command: async (args, options) => {
        if (args[2] === 'edit') throw new Error('标签失败')
        return s.options.command(args, options)
      },
    })
    expect(s.db.select().from(issues).get()).toMatchObject({ status: 'running', lastRunId: 2 })
    expect(s.logs.some((line) => line.includes('标签失败'))).toBe(true)
    expect(s.calls.map((call) => call.args[2])).toEqual(['view', 'view', 'comment'])
  } finally {
    await s.dispose()
  }
})

test('领取评论发送失败只记录日志，任务保持 running', async () => {
  const s = await scenario()
  try {
    await s.issue(42, 'queued')
    await launchQueued({
      ...s.options,
      executor: fakeExecutor(),
      command: async (args, options) => {
        if (args[2] === 'comment') throw new Error('评论失败')
        return s.options.command(args, options)
      },
    })
    expect(s.calls.map((call) => call.args[2])).toEqual(['view', 'edit'])
    expect(s.db.select().from(issues).get()?.status).toBe('running')
    expect(s.logs).toContain('github:a/b #42 发送领取评论失败：评论失败')
  } finally {
    await s.dispose()
  }
})

test('容器执行器拉起后记录 container，pid 保持空值', async () => {
  const s = await scenario()
  try {
    await s.issue(42, 'queued')
    await launchQueued({
      ...s.options,
      executor: fakeExecutor({
        async start(spec) {
          expect(spec.runId).toBe(1)
          expect(spec.ref).toBe('github:a/b#42')
          return { container: `workling-run-${spec.runId}` }
        },
      }),
    })
    expect(s.db.select().from(runs).get()).toMatchObject({ pid: null, container: 'workling-run-1' })
    expect(s.db.select().from(issues).get()?.status).toBe('running')
  } finally {
    await s.dispose()
  }
})

test('数据库模型更新后下一次拉起使用新配置，已拉起任务的配置不变', async () => {
  const s = await scenario()
  const specs: StartSpec[] = []
  const executor = fakeExecutor({
    async start(spec) {
      specs.push(spec)
      return { pid: 123 }
    },
  })
  try {
    updatePiSettings(s.db, { model: 'first-model', effort: 'high' })
    await s.issue(1, 'queued')
    await launchQueued({ ...s.options, pi: readPiSettings(s.db), executor })
    updatePiSettings(s.db, { model: 'next-model', piModel: 'next-pi' })
    await s.issue(2, 'queued')
    await launchQueued({
      ...s.options,
      pi: readPiSettings(s.db),
      executor,
      now: () => new Date(clock.getTime() + 1000),
    })
    expect(specs).toHaveLength(2)
    expect((await readSpec(specs[0]!.taskDir)).model).toEqual({
      codex: 'first-model',
      effort: 'high',
    })
    expect((await readSpec(specs[1]!.taskDir)).model).toEqual({
      codex: 'next-model',
      effort: 'high',
      pi: 'next-pi',
    })
  } finally {
    await s.dispose()
  }
})

test('Docker 缺少 LLM 地址时有排队任务只记录一次提示，不创建 run 或更新标签', async () => {
  const s = await scenario()
  try {
    const options = {
      ...s.options,
      executorSettings: parseExecutorSettings({ sandbox: 'docker' }),
      executor: fakeExecutor({
        async start() {
          throw new Error('不应拉起')
        },
      }),
    }
    await launchQueued(options)
    expect(s.logs).toEqual([])
    await s.issue(1, 'queued')
    await s.issue(2, 'queued')
    await launchQueued(options)
    expect(s.logs).toEqual(['docker 沙箱需要在设置页配置 LLM 接入地址，暂不拉起任务'])
    expect(s.db.select().from(runs).all()).toEqual([])
    expect(
      s.db
        .select()
        .from(issues)
        .all()
        .every((issue) => issue.status === 'queued' && issue.lastRunId === null),
    ).toBe(true)
    expect(s.calls).toEqual([])
    expect(await readdir(s.workspace)).not.toContain('tasks')
  } finally {
    await s.dispose()
  }
})

test('并发名额已满不拉起，保存新上限后下一轮使用数据库配置调度', async () => {
  const s = await scenario()
  try {
    await s.issue(1, 'running')
    await s.issue(2, 'queued')
    await s.issue(3, 'queued')
    let starts = 0
    const executor = fakeExecutor({
      async start() {
        starts++
        return { pid: 123 }
      },
    })
    updateExecutorSettings(s.db, { concurrency: 1 })
    await launchQueued({
      ...s.options,
      executorSettings: readExecutorSettings(s.db),
      executor,
    })
    expect(starts).toBe(0)
    updateExecutorSettings(s.db, { concurrency: 2 })
    await launchQueued({
      ...s.options,
      executorSettings: readExecutorSettings(s.db),
      executor,
    })
    expect(starts).toBe(1)
    expect(s.db.select().from(runs).all()).toHaveLength(1)
  } finally {
    await s.dispose()
  }
})

test('指令触发的重试在领取评论中注明链接', async () => {
  const s = await scenario()
  try {
    const issue = await s.issue(42, 'queued')
    const triggers = new Map([[issue.id, 'https://github.com/a/b/issues/42#issuecomment-1']])
    await launchQueued({
      ...s.options,
      triggers,
      executor: fakeExecutor({
        async start() {
          return { pid: 123 }
        },
      }),
    })
    expect(s.calls.find((call) => call.args[2] === 'comment')?.options?.input).toContain(
      '\n- 触发：https://github.com/a/b/issues/42#issuecomment-1',
    )
    expect(triggers.size).toBe(0)
  } finally {
    await s.dispose()
  }
})
