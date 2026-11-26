import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type WorklingDatabase } from '../src/db/index.ts'
import { issues, piSettings, repos, runs } from '../src/db/schema.ts'

function removeProgressMigration(db: WorklingDatabase) {
  db.run(sql`ALTER TABLE issues DROP COLUMN progress_comment_id`)
  db.run(sql`ALTER TABLE runs DROP COLUMN outcome`)
  db.run(
    sql`DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)`,
  )
}

function removeExecutionMigration(db: WorklingDatabase) {
  removeProgressMigration(db)
  for (const column of ['executor', 'difficulty', 'clarity', 'assessment_note'])
    db.run(sql.raw(`ALTER TABLE runs DROP COLUMN ${column}`))
  db.run(
    sql`DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)`,
  )
}

function removePlanMigration(db: WorklingDatabase) {
  removeExecutionMigration(db)
  db.run(sql`DROP TABLE plan_children`)
  db.run(sql`ALTER TABLE pi_settings DROP COLUMN plan_model`)
  db.run(sql`ALTER TABLE pi_settings DROP COLUMN plan_effort`)
  db.run(sql`ALTER TABLE runs DROP COLUMN plan_released_at`)
  db.run(
    sql`DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)`,
  )
}

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
    removePlanMigration(first.db)
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
    first.db.run(sql`ALTER TABLE runs DROP COLUMN stack_branch`)
    first.db.run(sql`DROP TABLE triage_records`)
    first.db.run(sql`ALTER TABLE repos DROP COLUMN triage_level`)
    first.db.run(sql`ALTER TABLE repos DROP COLUMN triage_since`)
    first.db.run(sql`ALTER TABLE runs DROP COLUMN kind`)
    first.db.run(sql`ALTER TABLE feedback DROP COLUMN review_id`)
    first.db.run(sql`DROP TABLE feedback`)
    first.db.run(sql`DROP TABLE feedback_cursors`)
    first.db.run(sql`DROP TABLE trusted_users`)
    first.db.run(sql`DROP TABLE update_settings`)
    first.db.run(sql`DROP TABLE reviews`)
    first.db.run(sql`ALTER TABLE repos DROP COLUMN review_level`)
    first.db.run(sql`ALTER TABLE repos DROP COLUMN review_since`)
    first.db.run(sql`ALTER TABLE pi_settings DROP COLUMN review_model`)
    first.db.run(sql`ALTER TABLE pi_settings DROP COLUMN review_effort`)
    first.db.run(
      sql`DELETE FROM __drizzle_migrations WHERE created_at IN (SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 8)`,
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

test('建议级迁移保留仓库数据并为新旧库创建可空列', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-upgrade-suggest-'))
  try {
    const first = await openDatabase(dir)
    removePlanMigration(first.db)
    const repoColumns = first.db.all<{ name: string }>(sql`PRAGMA table_info(repos)`)
    expect(repoColumns.some((c) => c.name === 'triage_since')).toBe(true)
    const columns = ['suggested_at', 'suggest_comment_url', 'suggest_error', 'label_removed_at']
    for (const name of columns)
      expect(
        first.db
          .all<{ name: string; notnull: number }>(sql`PRAGMA table_info(triage_records)`)
          .find((c) => c.name === name),
      ).toMatchObject({ notnull: 0 })
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
    first.db.run(sql`ALTER TABLE runs DROP COLUMN stack_branch`)
    for (const name of [...columns, 'auto_queued_at'])
      first.db.run(sql.raw(`ALTER TABLE triage_records DROP COLUMN ${name}`))
    first.db.run(sql`ALTER TABLE repos DROP COLUMN triage_since`)
    first.db.run(sql`DROP TABLE update_settings`)
    first.db.run(sql`DROP TABLE reviews`)
    first.db.run(sql`ALTER TABLE repos DROP COLUMN review_level`)
    first.db.run(sql`ALTER TABLE repos DROP COLUMN review_since`)
    first.db.run(sql`ALTER TABLE pi_settings DROP COLUMN review_model`)
    first.db.run(sql`ALTER TABLE pi_settings DROP COLUMN review_effort`)
    first.db.run(
      sql`DELETE FROM __drizzle_migrations WHERE created_at IN (SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 5)`,
    )
    first.close()
    const upgraded = await openDatabase(dir)
    expect(upgraded.db.select().from(repos).get()).toMatchObject({
      token: 'secret',
      triageSince: null,
    })
    for (const name of columns)
      expect(
        upgraded.db
          .all<{ name: string }>(sql`PRAGMA table_info(triage_records)`)
          .some((c) => c.name === name),
      ).toBe(true)
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
      removePlanMigration(first.db)
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
      first.db.run(sql`ALTER TABLE runs DROP COLUMN stack_branch`)
      for (const name of [
        'suggested_at',
        'suggest_comment_url',
        'suggest_error',
        'label_removed_at',
        'auto_queued_at',
      ])
        first.db.run(sql.raw(`ALTER TABLE triage_records DROP COLUMN ${name}`))
      first.db.run(sql`ALTER TABLE repos DROP COLUMN triage_since`)
      first.db.run(sql`DROP TABLE update_settings`)
      first.db.run(sql`DROP TABLE reviews`)
      first.db.run(sql`ALTER TABLE repos DROP COLUMN review_level`)
      first.db.run(sql`ALTER TABLE repos DROP COLUMN review_since`)
      first.db.run(sql`ALTER TABLE pi_settings DROP COLUMN review_model`)
      first.db.run(sql`ALTER TABLE pi_settings DROP COLUMN review_effort`)
      first.db.run(
        sql`DELETE FROM __drizzle_migrations WHERE created_at IN (SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 5)`,
      )
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

test('影子评审与拆解迁移保留已有仓库与模型，默认关闭评审并使用默认拆解配置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-upgrade-review-'))
  try {
    const first = await openDatabase(dir)
    removePlanMigration(first.db)
    first.db.run(sql`DROP TABLE reviews`)
    first.db.run(sql`ALTER TABLE repos DROP COLUMN review_level`)
    first.db.run(sql`ALTER TABLE repos DROP COLUMN review_since`)
    first.db.run(sql`ALTER TABLE pi_settings DROP COLUMN review_model`)
    first.db.run(sql`ALTER TABLE pi_settings DROP COLUMN review_effort`)
    first.db.run(
      sql`DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)`,
    )
    first.db.run(sql`
      INSERT INTO repos (ref, platform, host, path, token, created_at, updated_at)
      VALUES ('github:a/b', 'github', 'github.com', 'a/b', 'secret', 1, 1)
    `)
    first.db.run(sql`
      INSERT INTO pi_settings (id, model, effort, llm_api, git_name, git_email, updated_at)
      VALUES (1, 'current-model', 'medium', 'openai-responses', 'test', 'test@example.com', 1)
    `)
    first.close()
    const upgraded = await openDatabase(dir)
    try {
      expect(upgraded.db.select().from(repos).get()).toMatchObject({
        reviewLevel: 'off',
        reviewSince: null,
      })
      expect(upgraded.db.select().from(piSettings).get()).toMatchObject({
        model: 'current-model',
        reviewModel: null,
        reviewEffort: null,
        planModel: null,
        planEffort: null,
      })
      expect(upgraded.db.all(sql`SELECT * FROM reviews`)).toEqual([])
      expect(upgraded.db.all(sql`SELECT * FROM plan_children`)).toEqual([])
    } finally {
      upgraded.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('执行评估迁移为已有运行记录补上可空的执行方与评估列', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-upgrade-execution-'))
  try {
    const first = await openDatabase(dir)
    removeExecutionMigration(first.db)
    first.db.run(sql`
      INSERT INTO repos (ref, platform, host, path, token, created_at, updated_at)
      VALUES ('github:a/b', 'github', 'github.com', 'a/b', 'secret', 1, 1)
    `)
    first.db.run(sql`
      INSERT INTO issues (repo_id, number, status, created_at, updated_at)
      VALUES (1, 1, 'done', 1, 1)
    `)
    first.db.run(sql`
      INSERT INTO runs (issue_id, worker, started_at, report_result)
      VALUES (1, 'worker', 1, '完成')
    `)
    first.close()
    const upgraded = await openDatabase(dir)
    try {
      expect(upgraded.db.select().from(runs).get()).toMatchObject({
        reportResult: '完成',
        executor: null,
        difficulty: null,
        clarity: null,
        assessmentNote: null,
      })
      expect(
        upgraded.db
          .all<{ name: string; notnull: number }>(sql`PRAGMA table_info(runs)`)
          .filter(({ name }) =>
            ['executor', 'difficulty', 'clarity', 'assessment_note'].includes(name),
          ),
      ).toEqual(
        [
          { name: 'executor', notnull: 0 },
          { name: 'difficulty', notnull: 0 },
          { name: 'clarity', notnull: 0 },
          { name: 'assessment_note', notnull: 0 },
        ].map((column) => expect.objectContaining(column)),
      )
    } finally {
      upgraded.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('进度评论迁移保留旧 Issue 和运行，两列没有回填', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-upgrade-progress-'))
  try {
    const first = await openDatabase(dir)
    try {
      removeProgressMigration(first.db)
      first.db.run(sql`
        INSERT INTO repos (ref, platform, host, path, token, created_at, updated_at)
        VALUES ('github:a/b', 'github', 'github.com', 'a/b', 'secret', 1, 1)
      `)
      first.db.run(sql`
        INSERT INTO issues (repo_id, number, status, last_run_id, created_at, updated_at)
        VALUES (1, 42, 'done', 1, 1, 1)
      `)
      first.db.run(sql`
        INSERT INTO runs (issue_id, worker, started_at, ended_at, report_result)
        VALUES (1, 'worker', 1, 2, '完成')
      `)
    } finally {
      first.close()
    }
    const upgraded = await openDatabase(dir)
    try {
      expect(upgraded.db.select().from(issues).get()).toMatchObject({
        number: 42,
        status: 'done',
        lastRunId: 1,
        progressCommentId: null,
      })
      expect(upgraded.db.select().from(runs).get()).toMatchObject({
        endedAt: new Date(2000),
        reportResult: '完成',
        outcome: null,
      })
      expect(upgraded.db.all(sql`PRAGMA table_info(issues)`)).toContainEqual(
        expect.objectContaining({ name: 'progress_comment_id', type: 'INTEGER', notnull: 0 }),
      )
      expect(upgraded.db.all(sql`PRAGMA table_info(runs)`)).toContainEqual(
        expect.objectContaining({ name: 'outcome', type: 'TEXT', notnull: 0 }),
      )
    } finally {
      upgraded.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
