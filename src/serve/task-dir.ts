import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { IssueRef } from '../issue/reference.ts'

export function taskDirName(ref: IssueRef, now: Date): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `${ref.project.replace('/', '-')}-${ref.iid}-${timestamp}`
}

export async function createTaskDir(
  workspace: string,
  ref: IssueRef,
  now = new Date(),
): Promise<string> {
  const parent = resolve(workspace, 'tasks')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const dir = join(parent, taskDirName(ref, now))
  await mkdir(dir, { mode: 0o700 })
  return dir
}
