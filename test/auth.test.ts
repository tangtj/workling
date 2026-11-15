import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePassword, hashToken, resetPassword } from '../src/web/auth.ts'
import { openDatabase } from '../src/db/index.ts'
import { admin, sessions } from '../src/db/schema.ts'

test('首次初始化仅返回一次随机密码，重置覆盖哈希并撤销所有会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-password-'))
  const { db, close } = await openDatabase(dir)
  try {
    const password = await ensurePassword(db)
    expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(await ensurePassword(db)).toBeUndefined()
    const original = db.select().from(admin).get()!
    expect(original.id).toBe(1)
    expect(original.passwordHash).not.toBe(password)
    expect(original.passwordHash).toStartWith('$argon2id$')
    expect(await Bun.password.verify(password!, original.passwordHash)).toBe(true)
    for (const token of ['a', 'b'])
      db.insert(sessions)
        .values({
          id: hashToken(token),
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        })
        .run()
    const nextPassword = await resetPassword(db)
    expect(nextPassword).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(nextPassword).not.toBe(password)
    const updated = db.select().from(admin).get()!
    expect(await Bun.password.verify(password!, updated.passwordHash)).toBe(false)
    expect(await Bun.password.verify(nextPassword, updated.passwordHash)).toBe(true)
    expect(db.select().from(sessions).all()).toHaveLength(0)
    expect(db.select().from(admin).all()).toHaveLength(1)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('修改密码检查旧哈希并只保留指定会话', async () => {
  const { changePassword } = await import('../src/web/auth.ts')
  const dir = await mkdtemp(join(tmpdir(), 'workling-change-password-'))
  const { db, close } = await openDatabase(dir)
  try {
    await ensurePassword(db)
    const original = db.select().from(admin).get()!
    for (const id of ['keep', 'remove'])
      db.insert(sessions)
        .values({ id, createdAt: new Date(), expiresAt: new Date(Date.now() + 60000) })
        .run()
    expect(changePassword(db, 'stale', 'new-hash', 'keep')).toBe(false)
    expect(db.select().from(admin).get()).toEqual(original)
    expect(db.select().from(sessions).all()).toHaveLength(2)
    expect(changePassword(db, original.passwordHash, 'new-hash', 'keep')).toBe(true)
    expect(db.select().from(admin).get()!.passwordHash).toBe('new-hash')
    expect(
      db
        .select()
        .from(sessions)
        .all()
        .map((session) => session.id),
    ).toEqual(['keep'])
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})
