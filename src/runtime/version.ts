import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './paths.ts'

export function readVersion(root = ROOT): string {
  try {
    return readFileSync(join(root, 'VERSION'), 'utf8').trim() || 'dev'
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'dev'
    throw error
  }
}
