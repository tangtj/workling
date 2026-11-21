import { parseExecutorSettings } from '../../src/config/executor.ts'
import { eq } from 'drizzle-orm'
import type { Executor } from '../../src/executor/index.ts'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db/index.ts'
import { issues, repos, runs } from '../../src/db/schema.ts'
import type { Command, RunOptions } from '../../src/runtime/types.ts'
import { readPiSettings } from '../../src/config/pi.ts'
import { readSettings } from '../../src/config/env.ts'
import { tip, writeDeliveryFixture } from './delivery.ts'
export function fakeExecutor(overrides: Partial<Executor> = {}): Executor {
  return {
    async start() {
      return { pid: 123 }
    },
    async status() {
      return { running: false }
    },
    async signal() {},
    async finish() {},
    ...overrides,
  }
}

export const clock = new Date('2026-11-14T10:30:00Z')
export const baseRef = 'a'.repeat(40)

export async function scenario({ body = '测试正文' }: { body?: string } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'workling-watch-'))
  const { db, close } = await openDatabase(workspace)
  const settings = readSettings({
    WORKLING_WORKSPACE: workspace,
    WORKLING_WORKER: 'worker',
    WORKLING_TIMEOUT: '1',
  })
  const calls: { args: string[]; options?: RunOptions }[] = []
  const logs: string[] = []
  const repo = db
    .insert(repos)
    .values({
      ref: 'github:a/b',
      platform: 'github',
      host: 'github.com',
      path: 'a/b',
      token: 'repo-secret',
      createdAt: clock,
      updatedAt: clock,
    })
    .returning()
    .get()
  const command: Command = async (args, options) => {
    if (args[0] === 'gh' && args[1] === 'api' && args[2]?.endsWith('/parent'))
      throw new Error('HTTP 404')
    if (args[0] === 'git') {
      if (args[1] === 'init' && options?.cwd)
        await mkdir(join(options.cwd, 'objects/info'), { recursive: true })
      if (args[1] === 'rev-parse')
        return args[args.length - 1]!.startsWith('refs/heads/workling/') ? tip : baseRef
      if (args[1] === 'bundle') return `${tip} refs/heads/workling/42-issue`
      if (args[1] === 'rev-list') return '1'
      if (args.includes('ls-remote')) return `${tip}\t${args.at(-1)}`
      return ''
    }
    if (args[0] === 'gh' && args[1] === 'api' && args[4] === '.default_branch') return 'main'
    if (args[1] === 'issue' && args[2] === 'view' && args.at(-1) === 'labels')
      return JSON.stringify({ labels: [{ name: 'workling:running' }] })
    calls.push({ args, options })
    if (args[0] === 'gh' && args[1] === 'issue' && args[2] === 'view')
      return JSON.stringify({
        number: Number(args[3]),
        title: '测试 Issue',
        body,
        state: 'OPEN',
        url: `https://github.com/${args[5]}/issues/${args[3]}`,
        createdAt: clock.toISOString(),
        author: { login: 'author' },
        labels: [],
        comments: [],
      })
    if (args[1] === 'pr' && args[2] === 'list')
      return args.at(-1) === 'number,url,title,body,isDraft'
        ? '[]'
        : JSON.stringify([{ url: 'https://github.com/a/b/pull/1', state: 'OPEN', isDraft: false }])
    return ''
  }
  async function issue(
    number = 42,
    status: typeof issues.$inferSelect.status = 'running',
    repoId = repo.id,
  ) {
    return db
      .insert(issues)
      .values({ repoId, number, status, createdAt: clock, updatedAt: clock })
      .returning()
      .get()
  }
  async function running(
    options: {
      error?: string
      pid?: number | null
      container?: string
      taskDir?: string | null
      startedAt?: Date
      delivery?: boolean
    } = {},
  ) {
    const row = await issue()
    const dir =
      options.taskDir === undefined
        ? join(workspace, 'tasks', 'a-b-42-20261114T103000Z')
        : options.taskDir
    if (dir) await mkdir(dir, { recursive: true })
    const run = db
      .insert(runs)
      .values({
        issueId: row.id,
        worker: 'previous',
        taskDir: dir,
        pid: options.pid === undefined ? 123 : options.pid,
        container: options.container,
        error: options.error,
        ...(options.delivery ? { branch: 'workling/42-issue', baseRef } : {}),
        startedAt: options.startedAt ?? new Date(clock.getTime() - 61_000),
      })
      .returning()
      .get()
    db.update(issues).set({ lastRunId: run.id }).where(eq(issues.id, row.id)).run()
    if (dir && run.branch) await writeDeliveryFixture(dir, run.branch)
    return { issue: row, run, dir: dir! }
  }
  const options = {
    db,
    settings,
    pi: readPiSettings(db),
    executorSettings: parseExecutorSettings({}),
    signal: new AbortController().signal,
    command,
    log: (line: string) => logs.push(line),
    now: () => clock,
  }
  return {
    ...options,
    workspace,
    repo,
    calls,
    logs,
    issue,
    running,
    options,
    async dispose() {
      close()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}
