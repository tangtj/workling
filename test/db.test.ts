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

test('已有数据库升级反馈表时保留仓库数据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-upgrade-feedback-'))
  try {
    const first = await openDatabase(dir)
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
    first.db.run(sql`DROP TABLE triage_records`)
    first.db.run(sql`ALTER TABLE repos DROP COLUMN triage_level`)
    first.db.run(sql`ALTER TABLE runs DROP COLUMN kind`)
    first.db.run(sql`ALTER TABLE feedback DROP COLUMN review_id`)
    first.db.run(
      sql`DELETE FROM __drizzle_migrations WHERE created_at IN (SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 2)`,
    )
    first.close()
    const upgraded = await openDatabase(dir)
    expect(upgraded.db.select().from(repos).get()?.token).toBe('secret')
    for (const name of ['feedback', 'feedback_cursors', 'trusted_users']) {
      expect(
        upgraded.db.all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`,
        ),
      ).toHaveLength(1)
    }
    upgraded.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const existing of ['rework', 'triage'] as const) {
  test(`已有 ${existing} 迁移的数据库补齐另一分支并保留数据`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workling-merge-migrations-'))
    try {
      const first = await openDatabase(dir)
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
      if (existing === 'rework') {
        first.db.run(sql`DROP TABLE triage_records`)
        first.db.run(sql`ALTER TABLE repos DROP COLUMN triage_level`)
        first.db.run(sql`DELETE FROM __drizzle_migrations WHERE created_at = 1795247638712`)
      } else {
        first.db.run(sql`ALTER TABLE runs DROP COLUMN kind`)
        first.db.run(sql`ALTER TABLE feedback DROP COLUMN review_id`)
        first.db.run(sql`DELETE FROM __drizzle_migrations WHERE created_at = 1795247669128`)
      }
      first.close()
      const upgraded = await openDatabase(dir)
      expect(upgraded.db.select().from(repos).get()).toMatchObject({
        token: 'secret',
        triageLevel: 'off',
      })
      expect(
        upgraded.db
          .all<{ name: string }>(sql`PRAGMA table_info(runs)`)
          .some((column) => column.name === 'kind'),
      ).toBe(true)
      expect(
        upgraded.db
          .all<{ name: string }>(sql`PRAGMA table_info(feedback)`)
          .some((column) => column.name === 'review_id'),
      ).toBe(true)
      expect(upgraded.db.all(sql`SELECT * FROM triage_records`)).toEqual([])
      upgraded.close()
      const reopened = await openDatabase(dir)
      reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
