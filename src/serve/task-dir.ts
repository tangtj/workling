import { mkdir, mkdtemp } from 'node:fs/promises'
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
  kind?: 'review',
): Promise<string> {
  const parent = resolve(workspace, 'tasks')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const dir = join(parent, taskDirName(ref, now))
  // 评审可能与交付在同一秒建目录，也可能在同一秒内重试。
  if (kind === 'review') return mkdtemp(`${dir}-review-`)
  await mkdir(dir, { mode: 0o700 })
  return dir
}
