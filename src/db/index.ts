import { Database } from 'bun:sqlite'
import { chmod, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
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
    migrate(db, { migrationsFolder: resolve(ROOT, 'drizzle') })
    return { db, close: () => sqlite.close() }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

export type WorklingDatabase = Awaited<ReturnType<typeof openDatabase>>['db']
