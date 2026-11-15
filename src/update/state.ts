import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { TAG_PATTERN } from '../runtime/version.ts'

const version = Type.String({ pattern: `(?:${TAG_PATTERN})|^dev$` })
const nullableVersion = Type.Union([version, Type.Null()])
export const stateSchema = Type.Object(
  {
    current: nullableVersion,
    previous: nullableVersion,
    previousIsImage: Type.Boolean(),
    backup: Type.Union([Type.String(), Type.Null()]),
    pending: Type.Boolean(),
    attempts: Type.Integer({ minimum: 0 }),
    updatedAt: Type.String(),
    lastError: Type.Optional(Type.String()),
    lastSuccess: Type.Optional(
      Type.Object({ tag: version, at: Type.String() }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
)
export type UpdateState = Type.Static<typeof stateSchema>

export function readState(appHome: string): UpdateState | null {
  let text: string
  try {
    text = readFileSync(join(appHome, 'state.json'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  const state: unknown = JSON.parse(text)
  if (!Value.Check(stateSchema, state)) throw new Error('更新状态文件格式无效')
  return state
}

export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${crypto.randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

export function writeState(appHome: string, state: UpdateState): void {
  if (!Value.Check(stateSchema, state)) throw new Error('更新状态文件格式无效')
  atomicJson(join(appHome, 'state.json'), state)
}
