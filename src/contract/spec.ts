import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'

export const CONTRACT_VERSION = 1

export const specSchema = Type.Object({
  contract: Type.Literal(CONTRACT_VERSION),
  kind: Type.Literal('implement'),
  issue: Type.Object({ ref: Type.String(), title: Type.String() }),
  repo: Type.Object({
    baseRef: Type.String(),
    branch: Type.String(),
    docBranch: Type.Optional(Type.String()),
    continued: Type.Optional(Type.Boolean()),
  }),
  model: Type.Object({
    codex: Type.String(),
    effort: Type.Union([
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
      Type.Literal('xhigh'),
    ]),
    pi: Type.Optional(Type.String()),
  }),
  git: Type.Object({ name: Type.String(), email: Type.String() }),
})

export type Spec = Type.Static<typeof specSchema>

export async function writeSpec(dir: string, spec: Spec): Promise<void> {
  const tmp = join(dir, 'spec.json.tmp')
  await writeFile(tmp, JSON.stringify(spec), { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, join(dir, 'spec.json'))
}

export async function readSpec(dir: string): Promise<Spec> {
  let raw: string
  try {
    raw = await readFile(join(dir, 'spec.json'), 'utf8')
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
      throw new Error('缺少 spec.json', { cause })
    throw new Error('无法读取 spec.json', { cause })
  }
  let spec: unknown
  try {
    spec = JSON.parse(raw)
  } catch (cause) {
    throw new Error('spec.json 不是有效的 JSON', { cause })
  }
  if (
    spec !== null &&
    typeof spec === 'object' &&
    'contract' in spec &&
    spec.contract !== CONTRACT_VERSION
  )
    throw new Error(`spec.json 的契约版本不受支持，需要版本 ${CONTRACT_VERSION}`)
  if (!Value.Check(specSchema, spec)) throw new Error('spec.json 的结构无效')
  return spec
}
