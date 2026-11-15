import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '../..')
export const CLI = join(ROOT, 'src/cli.ts')
export const PI_CLI = resolve(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
