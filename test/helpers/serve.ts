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

export async function scenario() {
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
    calls.push({ args, options })
    return args[1] === 'pr'
      ? JSON.stringify([
          { url: 'wrong', headRefName: 'workling/420-task' },
          { url: 'https://github.com/a/b/pull/1', headRefName: 'workling/42-task' },
          { url: 'second', headRefName: 'workling/42-other' },
        ])
      : ''
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
        startedAt: options.startedAt ?? new Date(clock.getTime() - 61_000),
      })
      .returning()
      .get()
    db.update(issues).set({ lastRunId: run.id }).where(eq(issues.id, row.id)).run()
    return { issue: row, run, dir: dir! }
  }
  const options = {
    db,
    settings,
    pi: readPiSettings(db),
    executorSettings: parseExecutorSettings({}),
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
