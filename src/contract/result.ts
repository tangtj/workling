import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'

// 任务目录必须是工作区 tasks/ 的直接子目录；主体与 worker 都按这条规则校验路径。
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
