import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '../..')
export const CLI = join(ROOT, 'src/cli.ts')
export const WORKER_CLI = join(ROOT, 'worker/cli.ts')
