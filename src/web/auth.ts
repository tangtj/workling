import { eq, ne } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { admin, sessions } from '../db/schema.ts'

export function randomToken(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')
}

export function generatePassword(): string {
  return randomToken(18)
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex')
}

export async function ensurePassword(db: WorklingDatabase): Promise<string | undefined> {
  if (db.select().from(admin).where(eq(admin.id, 1)).get()) return undefined
  const password = generatePassword()
  const passwordHash = await Bun.password.hash(password, 'argon2id')
  // 并发启动时只有实际插入单用户记录的一方显示密码。
  const inserted = db
    .insert(admin)
    .values({ id: 1, passwordHash, updatedAt: new Date() })
    .onConflictDoNothing()
    .returning()
    .get()
  return inserted ? password : undefined
}

export async function resetPassword(db: WorklingDatabase): Promise<string> {
  const password = generatePassword()
  const passwordHash = await Bun.password.hash(password, 'argon2id')
  db.transaction((tx) => {
    tx.insert(admin)
      .values({ id: 1, passwordHash, updatedAt: new Date() })
      .onConflictDoUpdate({ target: admin.id, set: { passwordHash, updatedAt: new Date() } })
      .run()
    tx.delete(sessions).run()
  })
  return password
}

export function changePassword(
  db: WorklingDatabase,
  expectedHash: string,
  passwordHash: string,
  keepSessionId: string,
): boolean {
  return db.transaction((tx) => {
    if (tx.select().from(admin).where(eq(admin.id, 1)).get()?.passwordHash !== expectedHash)
      return false
    tx.update(admin).set({ passwordHash, updatedAt: new Date() }).where(eq(admin.id, 1)).run()
    tx.delete(sessions).where(ne(sessions.id, keepSessionId)).run()
    return true
  })
}
