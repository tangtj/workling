import { eq } from 'drizzle-orm'
import type { WorklingDatabase } from '../db/index.ts'
import { updateSettings } from '../db/schema.ts'

export function readUpdateChannel(db: WorklingDatabase): 'stable' | 'edge' {
  return db.select().from(updateSettings).where(eq(updateSettings.id, 1)).get()?.channel ?? 'stable'
}
export function updateUpdateChannel(db: WorklingDatabase, channel: 'stable' | 'edge') {
  const updatedAt = new Date()
  db.insert(updateSettings)
    .values({ id: 1, channel, updatedAt })
    .onConflictDoUpdate({ target: updateSettings.id, set: { channel, updatedAt } })
    .run()
  return { channel }
}
