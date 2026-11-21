import { constants } from 'node:fs'
import { open, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { CONTRACT_VERSION } from './spec.ts'

export const piOutcomeSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal('completed'),
    Type.Literal('partial'),
    Type.Literal('incomplete'),
    Type.Literal('answered'),
  ]),
})

export const outResultSchema = Type.Object({
  contract: Type.Literal(CONTRACT_VERSION),
  ...piOutcomeSchema.properties,
  branch: Type.String(),
  head: Type.Union([Type.String(), Type.Null()]),
  commits: Type.Integer({ minimum: 0 }),
})

export type OutResult = Type.Static<typeof outResultSchema>

export const checklistSchema = Type.Array(
  Type.Object({
    line: Type.String({ maxLength: 500, pattern: '^[^\\r\\n\\u2028\\u2029]*$' }),
    checked: Type.Boolean(),
    evidence: Type.String({ maxLength: 1000 }),
  }),
  { maxItems: 50 },
)

export type ChecklistItem = Type.Static<typeof checklistSchema>[number]

export function missingOutput(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

// out/ 对 worker 可写。只读取普通文件，拒绝符号链接和超出大小限制的内容。
export async function readOutputFile(
  dir: string,
  name: string,
  maxBytes: number,
  truncate = false,
): Promise<Buffer> {
  const handle = await open(
    join(dir, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`out/${name} 不是普通文件`)
    if (!truncate && stat.size > maxBytes) throw new Error(`out/${name} 超出大小限制`)
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, maxBytes) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) return buffer.subarray(0, offset)
      offset += bytesRead
    }
    if (truncate && stat.size >= maxBytes) return buffer
    throw new Error(`读取时 out/${name} 大小发生变化`)
  } finally {
    await handle.close()
  }
}

export async function readPiOutcome(dir: string): Promise<OutResult['outcome'] | undefined> {
  try {
    const raw = await readOutputFile(dir, 'outcome.json', 4096)
    const value: unknown = JSON.parse(raw.toString('utf8'))
    if (Value.Check(piOutcomeSchema, value)) return value.outcome
  } catch {
    // Pi 的输出不可用时仍可从报告判定结果。
  }
}

export async function readChecklist(dir: string): Promise<ChecklistItem[]> {
  // JSON 转义最多占每个 UTF-16 码元 6 字节，另外为结构与空白留出余量。
  const raw = await readOutputFile(dir, 'checklist.json', 512 * 1024).catch((error: unknown) => {
    if (missingOutput(error)) return undefined
    throw error
  })
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch (cause) {
    throw new Error('out/checklist.json 不是有效的 JSON', { cause })
  }
  if (!Value.Check(checklistSchema, value)) throw new Error('out/checklist.json 的结构无效')
  return value
}

export const maxCommentLength = 60_000

export function truncateComment(text: string): string {
  if (text.length <= maxCommentLength) return text
  const suffix = '\n\n（已截断）'
  const prefix = text.slice(0, maxCommentLength - suffix.length)
  return prefix.replace(/[\uD800-\uDBFF]$/, '') + suffix
}

export async function readIssueComment(dir: string): Promise<string> {
  const raw = await readOutputFile(dir, 'issue-comment.md', maxCommentLength * 3, true).catch(
    (error: unknown) => {
      if (missingOutput(error)) return undefined
      throw error
    },
  )
  return truncateComment(raw?.toString('utf8') ?? '')
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
    if (missingOutput(cause)) throw new Error('缺少 out/result.json', { cause })
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
