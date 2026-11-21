import { eq } from 'drizzle-orm'
import { feedback } from '../../db/schema.ts'
import type { UpgradeContext } from '../index.ts'

export const description = '忽略上线前仅观察的反馈'

export async function run({ db }: UpgradeContext): Promise<void> {
  db.update(feedback).set({ status: 'ignored' }).where(eq(feedback.status, 'observed')).run()
}
