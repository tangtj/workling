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
