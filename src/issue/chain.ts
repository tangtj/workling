import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { ghEnv } from '../platform/github.ts'
import type { Command } from '../runtime/types.ts'

const subSchema = Type.Array(
  Type.Object({
    number: Type.Integer(),
    title: Type.String(),
    state: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
    state_reason: Type.Union([Type.String(), Type.Null()]),
    repository_url: Type.String(),
  }),
)
const parentSchema = Type.Object({ number: Type.Integer() })
type Repo = { path: string; token: string; host: string }
type Options = { repo: Repo; number: number; command: Command; signal: AbortSignal }
export type SubIssue = {
  number: number
  title: string
  state: 'open' | 'closed'
  stateReason: string | null
  sameRepo: boolean
}

export async function readSubIssues({
  repo,
  number,
  command,
  signal,
}: Options): Promise<SubIssue[]> {
  const value: unknown = JSON.parse(
    await command(['gh', 'api', `repos/${repo.path}/issues/${number}/sub_issues?per_page=100`], {
      env: ghEnv(repo.token, repo.host),
      signal,
    }),
  )
  if (!Value.Check(subSchema, value)) throw new Error('子 Issue 列表格式无效')
  return value.map((sub) => ({
    number: sub.number,
    title: sub.title,
    state: sub.state,
    stateReason: sub.state_reason,
    sameRepo: sub.repository_url.toLowerCase().endsWith(`/repos/${repo.path}`.toLowerCase()),
  }))
}
export async function readParent({
  repo,
  number,
  command,
  signal,
}: Options): Promise<{ number: number } | undefined> {
  let output: string
  try {
    output = await command(['gh', 'api', `repos/${repo.path}/issues/${number}/parent`], {
      env: ghEnv(repo.token, repo.host),
      signal,
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('HTTP 404')) return undefined
    throw error
  }
  const value: unknown = JSON.parse(output)
  if (!Value.Check(parentSchema, value)) throw new Error('父 Issue 格式无效')
  return { number: value.number }
}
export function previousSibling(subs: SubIssue[], number: number): SubIssue | undefined {
  const index = subs.findIndex((sub) => sub.number === number)
  if (index < 0) return undefined
  return subs
    .slice(0, index)
    .reverse()
    .find((sub) => !(sub.state === 'closed' && sub.stateReason === 'not_planned'))
}
