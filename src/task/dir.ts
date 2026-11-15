import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
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

export function assertTaskDir(workspace: string, dir: string): string {
  const path = resolve(dir)
  if (dirname(path) !== resolve(workspace, 'tasks')) throw new Error(`任务目录无效：${dir}`)
  return path
}

export const resultSchema = Type.Object({
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  finishedAt: Type.String(),
  error: Type.Optional(Type.String()),
})

export async function writeResult(
  dir: string,
  result: Type.Static<typeof resultSchema>,
): Promise<void> {
  await writeFile(join(dir, 'result.json.tmp'), JSON.stringify(result))
  await rename(join(dir, 'result.json.tmp'), join(dir, 'result.json'))
}

export async function readResult(
  dir: string,
): Promise<Type.Static<typeof resultSchema> | undefined | 'invalid'> {
  let raw: string
  try {
    raw = await readFile(join(dir, 'result.json'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const result: unknown = JSON.parse(raw)
    return Value.Check(resultSchema, result) ? result : 'invalid'
  } catch {
    return 'invalid'
  }
}
