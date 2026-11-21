import {
  parseExecutorSettings,
  readExecutorSettings,
  updateExecutorSettings,
} from '../src/config/executor.ts'
import { eq } from 'drizzle-orm'
import type { StartSpec } from '../src/executor/index.ts'
import { expect, test } from 'bun:test'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readLlmSecrets } from '../src/contract/secrets.ts'
import { readSpec } from '../src/contract/spec.ts'
import { issues, repos, runs } from '../src/db/schema.ts'
import { parsePiSettings, readPiSettings, updatePiSettings } from '../src/config/pi.ts'
import { launchQueued } from '../src/serve/launch.ts'
import { reconcile } from '../src/serve/reconcile.ts'
import { readResult } from '../src/task/dir.ts'
import { localRemote } from './helpers/git.ts'
import { baseRef, fakeExecutor, clock, scenario } from './helpers/serve.ts'

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
          expect(spec.env.WORKLING_WORKSPACE).toBe(s.workspace)
          expect(spec.env).not.toHaveProperty('GH_TOKEN')
          expect(await readLlmSecrets(dir)).toBeNull()
          expect(await readSpec(dir)).toEqual({
            contract: 1,
            kind: 'implement',
            issue: { ref: 'github:a/b#2', title: '测试 Issue' },
            repo: { baseRef, branch: 'workling/2-issue' },
            model: { codex: pi.model, effort: pi.effort, pi: 'pi-model' },
            git: { name: pi.gitName, email: pi.gitEmail },
          })
          expect(await readFile(join(dir, 'input', 'issue.md'), 'utf8')).toContain('测试正文')
          expect((await readdir(join(dir, 'input'))).sort()).toEqual([
            'branch.md',
            'docs.md',
            'issue.json',
            'issue.md',
            'pr.md',
            'runs.md',
          ])
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
    expect(s.calls[1]?.args.slice(0, 6)).toEqual(['gh', 'pr', 'list', '-R', 'a/b', '--head'])
    expect(s.calls[2]!.args).toEqual([
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
    expect(s.calls[3]!.args).toEqual([
      'gh',
      'issue',
      'comment',
      '2',
      '-R',
      'a/b',
      '--body-file',
      '-',
    ])
    expect(s.calls[3]!.options?.input).toBe(
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

test('拉起时配置 LLM 才写密钥文件，平台凭证与旧配置不传入 worker', async () => {
  const removed = [
    'GH_TOKEN',
    'WORKLING_UPDATE_TOKEN',
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
  const configured = await scenario()
  try {
    await configured.issue(42, 'queued')
    let spec: StartSpec | undefined
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
          expect((await stat(join(value.taskDir, 'secrets/llm.json'))).mode & 0o777).toBe(0o600)
          expect(await readLlmSecrets(value.taskDir)).toEqual({
            baseUrl: 'https://llm.example/v1',
            apiKey: 'distinctive-fake-key',
            api: 'openai-completions',
          })
          return { pid: 700 }
        },
      }),
    })
    expect(spec).toBeDefined()
    for (const name of removed) expect(spec!.env).not.toHaveProperty(name)
    expect(Object.keys(spec!.env).filter((key) => key.startsWith('WORKLING_LLM_'))).toEqual([])
    expect(JSON.stringify(spec)).not.toContain('distinctive-fake-key')
  } finally {
    await configured.dispose()
  }
  const unset = await scenario()
  try {
    await unset.issue(42, 'queued')
    let spec: StartSpec | undefined
    await launchQueued({
      ...unset.options,
      executor: fakeExecutor({
        async start(value) {
          spec = value
          return { pid: 701 }
        },
      }),
    })
    expect(spec).toBeDefined()
    expect(await readLlmSecrets(spec!.taskDir)).toBeNull()
    for (const name of removed) expect(spec!.env).not.toHaveProperty(name)
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
      pi: parsePiSettings({ llmBaseUrl: 'https://llm.example', llmApiKey: 'fake-key' }),
      executor: fakeExecutor({
        async start(spec) {
          expect(await readLlmSecrets(spec.taskDir)).not.toBeNull()
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
    const taskDir = s.db.select().from(runs).get()!.taskDir!
    expect(await readdir(taskDir)).not.toContain('secrets')
    expect(s.calls.map((call) => call.args[2])).toEqual(['view', 'list'])
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
    expect(s.calls.map((call) => call.args[2])).toEqual(['view', 'list', 'view', 'list', 'comment'])
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
    expect(s.calls.map((call) => call.args[2])).toEqual(['view', 'list', 'edit'])
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

test.each([
  ['默认分支', '没有文档分支', undefined, 'latest default'],
  ['文档分支', '分支：docs/design', 'docs/design', 'design'],
] as const)('真实 Git：主体从%s检出任务分支并写好契约', async (_kind, body, docBranch, content) => {
  const s = await scenario({ body })
  try {
    const remote = await localRemote(s.workspace)
    // bare 远端 HEAD 指向 main；应以 API 返回的 trunk 为准。
    const initial = await remote.commit('refs/heads/main', 'initial')
    const design = await remote.commit('refs/heads/docs/design', 'design', initial)
    const latest = await remote.commit('refs/heads/trunk', 'latest default', initial)
    const baseRef = docBranch ? design : latest
    const baseRequests: string[][] = []
    await s.issue(42, 'queued')
    await launchQueued({
      ...s.options,
      command: (args, options) => {
        if (args[0] === 'git') return remote.git(args, options)
        if (args[1] === 'api') {
          baseRequests.push(args)
          return Promise.resolve('trunk')
        }
        return s.command(args, options)
      },
      executor: fakeExecutor({
        async start({ taskDir }) {
          const cwd = join(taskDir, 'repo')
          const git = (args: string[]) => remote.git(['git', ...args], { cwd })
          expect(await git(['branch', '--show-current'])).toBe('workling/42-issue')
          expect(await git(['rev-parse', 'HEAD'])).toBe(baseRef)
          expect(await git(['config', '--local', 'remote.origin.url'])).toBe(
            join(s.workspace, 'mirrors/github.com/a/b.git'),
          )
          expect(await git(['config', '--local', 'remote.origin.pushurl'])).toBe(
            'no-push://disabled',
          )
          expect(await git(['config', '--local', 'remote.origin.fetch'])).toBe(
            '+refs/heads/*:refs/remotes/origin/*',
          )
          expect(await git(['config', '--local', 'user.name'])).toBe(s.pi.gitName)
          expect(await git(['config', '--local', 'user.email'])).toBe(s.pi.gitEmail)
          expect(await readFile(join(cwd, 'content.txt'), 'utf8')).toBe(content)
          expect(await Bun.file(join(cwd, '.git/objects/info/alternates')).exists()).toBe(false)
          const object = join('objects', baseRef.slice(0, 2), baseRef.slice(2))
          const mirrorObject = join(s.workspace, 'mirrors/github.com/a/b.git', object)
          expect((await stat(join(cwd, '.git', object))).ino).not.toBe(
            (await stat(mirrorObject)).ino,
          )
          expect((await readSpec(taskDir)).repo).toEqual({
            baseRef,
            branch: 'workling/42-issue',
            ...(docBranch ? { docBranch } : {}),
          })
          expect(await readFile(join(taskDir, 'input', 'docs.md'), 'utf8')).toBe(
            docBranch ? '文档分支：docs/design\n- content.txt' : '无文档分支。',
          )
          return { pid: 123 }
        },
      }),
    })
    expect(baseRequests).toEqual([['gh', 'api', 'repos/a/b', '--jq', '.default_branch']])
    expect(s.db.select().from(runs).get()).toMatchObject({
      pid: 123,
      branch: 'workling/42-issue',
      baseRef,
    })
  } finally {
    await s.dispose()
  }
})

test.each([
  ['open', '分支：docs/design', '接续已有工作分支并保留文档分支'],
  ['merged', '没有文档分支', '从默认分支重开并在同名分支后加运行号'],
] as const)('真实 Git：上次 PR 为 %s（%s）时%s', async (prState, body, _behavior) => {
  const s = await scenario({ body })
  try {
    const remote = await localRemote(s.workspace)
    const main = await remote.commit('refs/heads/main', 'initial')
    const design = await remote.commit('refs/heads/docs/design', 'design', main)
    const branch = 'workling/42-issue'
    const previousBranch = prState === 'open' ? 'workling/42-old-title' : branch
    const previousTip = await remote.commit(`refs/heads/${previousBranch}`, 'previous work', design)
    const issue = await s.issue(42, 'queued')
    s.db.update(issues).set({ prState }).where(eq(issues.id, issue.id)).run()
    for (const prior of ['workling/42-older', previousBranch, '', null])
      s.db
        .insert(runs)
        .values({ issueId: issue.id, worker: 'old', startedAt: clock, branch: prior })
        .run()

    await launchQueued({
      ...s.options,
      command: (args, options) =>
        args[0] === 'git' ? remote.git(args, options) : s.command(args, options),
      executor: fakeExecutor(),
    })
    const row = s.db.select().from(issues).where(eq(issues.id, issue.id)).get()!
    expect(row.status).toBe('running')
    const run = s.db.select().from(runs).where(eq(runs.id, row.lastRunId!)).get()!
    const expected =
      prState === 'open'
        ? {
            branch: previousBranch,
            baseRef: previousTip,
            docBranch: 'docs/design',
            continued: true,
          }
        : { branch: `${branch}-${run.id}`, baseRef: main }
    expect(run).toMatchObject({ branch: expected.branch, baseRef: expected.baseRef })
    expect((await readSpec(run.taskDir!)).repo).toEqual(expected)
    const cwd = join(run.taskDir!, 'repo')
    expect(await remote.git(['git', 'branch', '--show-current'], { cwd })).toBe(expected.branch)
    expect(await remote.git(['git', 'rev-parse', 'HEAD'], { cwd })).toBe(expected.baseRef)
  } finally {
    await s.dispose()
  }
})

test.each([
  ['真实 Git：', '分支：docs/missing', '文档分支「docs/missing」不存在'],
  ['', '分支：docs/missing', '文档分支「docs/missing」不存在'],
  ['', '分支：docs/with space', 'Issue 正文的「分支：」行未填写有效的文档分支名'],
] as const)('%s主体将 %j 写为待对账的输入错误，不启动执行器', async (realGit, body, error) => {
  const s = await scenario({ body })
  try {
    const remote = realGit ? await localRemote(s.workspace) : undefined
    if (remote) {
      const main = await remote.commit('refs/heads/main', 'initial')
      // 同前缀分支也不能匹配缺失的文档分支。
      await remote.commit('refs/heads/docs/missing/nested', 'nested design', main)
    }
    const issue = await s.issue(42, 'queued')
    await launchQueued({
      ...s.options,
      command: (args, options) =>
        remote && args[0] === 'git' ? remote.git(args, options) : s.command(args, options),
      executor: fakeExecutor({
        async start() {
          throw new Error('不应拉起')
        },
      }),
    })
    const run = s.db.select().from(runs).get()!
    expect(run).toMatchObject({ pid: null, container: null, endedAt: null, error: null })
    expect(s.db.select().from(issues).get()).toMatchObject({ status: 'running', lastRunId: run.id })
    expect(await readResult(run.taskDir!)).toEqual({
      exitCode: null,
      signal: null,
      finishedAt: clock.toISOString(),
      error,
    })
    expect(await Bun.file(join(run.taskDir!, 'spec.json')).exists()).toBe(false)
    expect(s.calls.find(({ args }) => args[2] === 'edit')?.args.at(-1)).toBe('workling:running')

    await reconcile(s.options)
    expect(s.db.select().from(issues).where(eq(issues.id, issue.id)).get()?.status).toBe('failed')
    expect(s.db.select().from(runs).get()).toMatchObject({ error, endedAt: clock, exitCode: null })
    expect(
      s.calls
        .filter(({ args }) => args[2] === 'edit')
        .at(-1)
        ?.args.at(-1),
    ).toBe('workling:failed')
    expect(s.calls.filter(({ args }) => args[2] === 'comment').at(-1)?.options?.input).toContain(
      error,
    )
  } finally {
    await s.dispose()
  }
})

test.each([
  ['fetch', undefined],
  ['默认分支查询', undefined],
  ['文档分支查询', '分支：docs/design'],
] as const)('%s命令失败时保留 queued，下轮可重试', async (kind, body) => {
  const s = await scenario({ body })
  try {
    await s.issue(42, 'queued')
    const failure = `${kind}失败`
    await launchQueued({
      ...s.options,
      command: async (args, options) => {
        if (
          (kind === 'fetch' && args.includes('fetch')) ||
          (kind === '默认分支查询' && args[1] === 'api') ||
          (kind === '文档分支查询' && args[1] === 'for-each-ref')
        )
          throw new Error(failure)
        return s.command(args, options)
      },
      executor: fakeExecutor({
        async start() {
          throw new Error('不应拉起')
        },
      }),
    })
    expect(s.db.select().from(issues).get()).toMatchObject({ status: 'queued', lastRunId: null })
    const run = s.db.select().from(runs).get()!
    expect(run).toMatchObject({ error: `拉起失败：${failure}`, endedAt: clock, pid: null })
    expect(await readResult(run.taskDir!)).toBeUndefined()
    expect(s.calls.map(({ args }) => args[2])).toEqual(['view'])
  } finally {
    await s.dispose()
  }
})
