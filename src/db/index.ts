import { Database } from 'bun:sqlite'
import { chmod, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { ROOT } from '../runtime/paths.ts'
import * as schema from './schema.ts'

export async function openDatabase(workspace: string) {
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const path = resolve(workspace, 'workling.db')
  const sqlite = new Database(path, { create: true })
  try {
    // SQLite 默认关闭外键，级联删除依赖显式开启。
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.exec('PRAGMA journal_mode = WAL')
    sqlite.exec('PRAGMA busy_timeout = 5000')
    // 数据库包含仓库 token，限制本机其他用户读取。
    await chmod(path, 0o600)
    const db = drizzle(sqlite, { schema })
    // 两个分支各自发布了 0004；Drizzle 只看最新时间戳，需要补上较早的迁移。
    const migrationsFolder = resolve(ROOT, 'drizzle')
    const hasHistory = sqlite
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get()
    if (hasHistory) {
      const rework = sqlite
        .query('SELECT 1 FROM __drizzle_migrations WHERE created_at = ?')
        .get(1795247669128)
      const triage = sqlite
        .query('SELECT 1 FROM __drizzle_migrations WHERE created_at = ?')
        .get(1795247638712)
      if (rework && !triage) {
        const migration = readMigrationFiles({ migrationsFolder }).find(
          (item) => item.folderMillis === 1795247638712,
        )
        if (!migration) throw new Error('Missing triage migration')
        sqlite.transaction(() => {
          for (const statement of migration.sql) sqlite.exec(statement)
          sqlite
            .query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
            .run(migration.hash, migration.folderMillis)
        })()
      }
    }
    migrate(db, { migrationsFolder })
    return { db, close: () => sqlite.close() }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

export type WorklingDatabase = Awaited<ReturnType<typeof openDatabase>>['db']
