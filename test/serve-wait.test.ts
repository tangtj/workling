import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos, runs } from '../src/db/schema.ts'
import { waitForNext } from '../src/serve/wait.ts'

async function setup(
  status: 'running' | 'done' = 'running',
  kind: 'implement' | 'review' = 'implement',
) {
  const dir = await mkdtemp(join(tmpdir(), 'workling-wait-'))
  const { db, close } = await openDatabase(dir)
  const now = new Date()
  const repo = db
    .insert(repos)
    .values({
      ref: 'github:a/b',
      platform: 'github',
      host: 'github.com',
      path: 'a/b',
      token: 'token',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  const issue = db
    .insert(issues)
    .values({ repoId: repo.id, number: 1, status, createdAt: now, updatedAt: now })
    .returning()
    .get()
  const run = db
    .insert(runs)
    .values({ issueId: issue.id, worker: 'w', taskDir: dir, startedAt: now, kind })
    .returning()
    .get()
  if (kind === 'implement')
    db.update(issues).set({ lastRunId: run.id }).where(eq(issues.id, issue.id)).run()
  return {
    db,
    dir,
    dispose: async () => {
      close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test.each(['implement', 'review'] as const)(
  '等待期间 %s 运行出现结果时提前唤醒',
  async (kind) => {
    const s = await setup(kind === 'review' ? 'done' : 'running', kind)
    try {
      const waiting = waitForNext({
        db: s.db,
        seconds: 6,
        signal: new AbortController().signal,
        immediate: false,
      })
      await writeFile(join(s.dir, 'result.json'), '{}')
      expect(await waiting).toBe('finished')
    } finally {
      await s.dispose()
    }
  },
  8000,
)

test('等待前已有结果时等到间隔结束', async () => {
  const s = await setup()
  try {
    await writeFile(join(s.dir, 'result.json'), '{}')
    expect(
      await waitForNext({
        db: s.db,
        seconds: 5.2,
        signal: new AbortController().signal,
        immediate: false,
      }),
    ).toBe('interval')
  } finally {
    await s.dispose()
  }
}, 8000)

test('非 running Issue 出现结果时不唤醒', async () => {
  const s = await setup('done')
  try {
    const waiting = waitForNext({
      db: s.db,
      seconds: 5.2,
      signal: new AbortController().signal,
      immediate: false,
    })
    await writeFile(join(s.dir, 'result.json'), '{}')
    expect(await waiting).toBe('interval')
  } finally {
    await s.dispose()
  }
}, 8000)

test('immediate 为 true 时立即返回', async () => {
  const s = await setup()
  try {
    expect(
      await waitForNext({
        db: s.db,
        seconds: 60,
        signal: new AbortController().signal,
        immediate: true,
      }),
    ).toBe('immediate')
  } finally {
    await s.dispose()
  }
})

test('abort 后立即返回', async () => {
  const s = await setup()
  try {
    const controller = new AbortController()
    const waiting = waitForNext({
      db: s.db,
      seconds: 60,
      signal: controller.signal,
      immediate: false,
    })
    controller.abort()
    expect(await waiting).toBe('aborted')
  } finally {
    await s.dispose()
  }
})
