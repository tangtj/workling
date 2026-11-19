import { constants } from 'node:fs'
import { open, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { CONTRACT_VERSION } from './spec.ts'

export const outResultSchema = Type.Object({
  contract: Type.Literal(CONTRACT_VERSION),
  outcome: Type.Union([
    Type.Literal('completed'),
    Type.Literal('partial'),
    Type.Literal('incomplete'),
  ]),
  branch: Type.String(),
  head: Type.Union([Type.String(), Type.Null()]),
  commits: Type.Integer({ minimum: 0 }),
})

export type OutResult = Type.Static<typeof outResultSchema>

// out/ 对 worker 可写。只读取普通文件，拒绝符号链接和超出大小限制的内容。
export async function readOutputFile(dir: string, name: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(
    join(dir, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`out/${name} 不是普通文件`)
    if (stat.size > maxBytes) throw new Error(`out/${name} 超出大小限制`)
    const buffer = Buffer.allocUnsafe(stat.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) return buffer.subarray(0, offset)
      offset += bytesRead
    }
    throw new Error(`读取时 out/${name} 大小发生变化`)
  } finally {
    await handle.close()
  }
}

export async function writeOutResult(dir: string, value: OutResult): Promise<void> {
  const tmp = join(dir, 'result.json.tmp')
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, join(dir, 'result.json'))
}

export async function readOutResult(dir: string): Promise<OutResult> {
  let raw: string
  try {
    raw = (await readOutputFile(dir, 'result.json', 64 * 1024)).toString('utf8')
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
      throw new Error('缺少 out/result.json', { cause })
    throw new Error('无法读取 out/result.json', { cause })
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw new Error('out/result.json 不是有效的 JSON', { cause })
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    'contract' in value &&
    value.contract !== CONTRACT_VERSION
  )
    throw new Error(`out/result.json 的契约版本不受支持，需要版本 ${CONTRACT_VERSION}`)
  if (!Value.Check(outResultSchema, value)) throw new Error('out/result.json 的结构无效')
  return value
}
