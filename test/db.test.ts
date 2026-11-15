import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos, runs } from '../src/db/schema.ts'

test('新库包含全部可空列（runs.pid/container 等、issues.title）并启用 WAL、busy_timeout，权限与重开数据保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-db-'))
  try {
    const first = await openDatabase(dir)
    expect(first.db.all(sql`PRAGMA journal_mode`)).toEqual([{ journal_mode: 'wal' }])
    expect(first.db.all(sql`PRAGMA busy_timeout`)).toEqual([{ timeout: 5000 }])
    expect(first.db.all(sql`PRAGMA table_info(upgrade_steps)`)).toMatchObject([
      { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'description', type: 'TEXT', notnull: 1 },
      { name: 'applied_at', type: 'INTEGER', notnull: 1 },
    ])
    expect(
      first.db
        .all<{ name: string }>(sql`PRAGMA table_info(runs)`)
        .some((column) => column.name === 'pid'),
    ).toBe(true)
    const runColumns = first.db.all<{ name: string; notnull: number }>(sql`PRAGMA table_info(runs)`)
    for (const name of ['pid', 'container', 'summary', 'report_result', 'log_tail'])
      expect(runColumns.find((column) => column.name === name)).toMatchObject({ notnull: 0 })
    expect(
      first.db
        .all<{ name: string; notnull: number }>(sql`PRAGMA table_info(issues)`)
        .find((column) => column.name === 'title'),
    ).toMatchObject({ notnull: 0 })
    expect((await stat(join(dir, 'workling.db'))).mode & 0o777).toBe(0o600)
    const now = new Date()
    first.db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'secret',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    first.close()
    const second = await openDatabase(dir)
    expect(second.db.select().from(repos).all()).toHaveLength(1)
    expect(second.db.select().from(repos).get()?.token).toBe('secret')
    second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('删除仓库级联删除 Issue 和执行记录，重开后仍启用外键', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-cascade-'))
  let connection = await openDatabase(dir)
  try {
    const now = new Date()
    const project = connection.db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'secret',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    const issue = connection.db
      .insert(issues)
      .values({
        repoId: project.id,
        number: 1,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    connection.db.insert(runs).values({ issueId: issue.id, worker: 'worker', startedAt: now }).run()
    expect(() =>
      connection.db
        .insert(issues)
        .values({
          repoId: project.id,
          number: 1,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow()
    connection.close()
    connection = await openDatabase(dir)
    expect(connection.db.select().from(issues).all()).toHaveLength(1)
    expect(connection.db.select().from(runs).all()).toHaveLength(1)
    connection.db.delete(repos).run()
    expect(connection.db.select().from(issues).all()).toEqual([])
    expect(connection.db.select().from(runs).all()).toEqual([])
  } finally {
    connection.close()
    await rm(dir, { recursive: true, force: true })
  }
})
