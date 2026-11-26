import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { missingOutput, readOutputFile } from './output-file.ts'
import { CONTRACT_VERSION } from './spec.ts'
import { reviewSchema, type Review } from './review.ts'

export { missingOutput, readOutputFile } from './output-file.ts'
export { planSchema, readPlan, type Plan } from './plan.ts'
export { reviewSchema, type Review } from './review.ts'

export const piOutcomeSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal('completed'),
    Type.Literal('partial'),
    Type.Literal('incomplete'),
    Type.Literal('answered'),
    Type.Literal('reviewed'),
    Type.Literal('planned'),
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
type TaskOutcome = Exclude<OutResult['outcome'], 'reviewed' | 'planned'>

export const checklistSchema = Type.Array(
  Type.Object({
    line: Type.String({ maxLength: 500, pattern: '^[^\\r\\n\\u2028\\u2029]*$' }),
    checked: Type.Boolean(),
    evidence: Type.String({ maxLength: 1000 }),
  }),
  { maxItems: 50 },
)

export type ChecklistItem = Type.Static<typeof checklistSchema>[number]

export const repliesSchema = Type.Array(
  Type.Object({
    feedbackId: Type.Integer({ minimum: 1 }),
    body: Type.String({ minLength: 1, maxLength: 10_000 }),
  }),
  { maxItems: 100 },
)

export type Reply = Type.Static<typeof repliesSchema>[number]

export async function readPiOutcome(dir: string): Promise<OutResult['outcome'] | undefined> {
  try {
    const raw = await readOutputFile(dir, 'outcome.json', 4096)
    const value: unknown = JSON.parse(raw.toString('utf8'))
    if (Value.Check(piOutcomeSchema, value)) return value.outcome
  } catch {
    // 调用方决定产出不可用时是否回退到报告。
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

export async function readReplies(dir: string): Promise<Reply[]> {
  const raw = await readOutputFile(dir, 'replies.json', 1024 * 1024).catch((error: unknown) => {
    if (missingOutput(error)) return undefined
    throw error
  })
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch (cause) {
    throw new Error('out/replies.json 不是有效的 JSON', { cause })
  }
  if (!Value.Check(repliesSchema, value)) throw new Error('out/replies.json 的结构无效')
  return value
}

export async function readReview(dir: string): Promise<Review> {
  const raw = await readOutputFile(dir, 'review.json', 1024 * 1024).catch((cause: unknown) => {
    if (missingOutput(cause)) throw new Error('缺少 out/review.json', { cause })
    throw cause
  })
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch (cause) {
    throw new Error('out/review.json 不是有效的 JSON', { cause })
  }
  if (!Value.Check(reviewSchema, value)) throw new Error('out/review.json 的结构无效')
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

// 交付流程默认只读取实现和返工产出。评审与拆解调用方显式启用各自的结果。
export function readOutResult(dir: string): Promise<OutResult & { outcome: TaskOutcome }>
export function readOutResult(
  dir: string,
  options: { allowReview: true },
): Promise<OutResult & { outcome: TaskOutcome | 'reviewed' }>
export function readOutResult(
  dir: string,
  options: { allowPlan: true },
): Promise<OutResult & { outcome: TaskOutcome | 'planned' }>
export async function readOutResult(
  dir: string,
  options?: { allowReview?: true; allowPlan?: true },
): Promise<OutResult> {
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
  if (
    !Value.Check(outResultSchema, value) ||
    (value.outcome === 'reviewed' && !options?.allowReview) ||
    (value.outcome === 'planned' && !options?.allowPlan)
  )
    throw new Error('out/result.json 的结构无效')
  return value
}
