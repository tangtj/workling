import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { ghEnv } from '../platform/github.ts'
import type { repos } from '../db/schema.ts'
import type { Command } from '../runtime/types.ts'

const labelsSchema = Type.Object({ labels: Type.Array(Type.Object({ name: Type.String() })) })
const statuses = ['queued', 'running', 'done', 'failed'] as const

export async function setStatusLabel({
  repo,
  number,
  target,
  command,
  signal,
  removeReady = false,
}: {
  repo: typeof repos.$inferSelect
  number: number
  target: (typeof statuses)[number] | null
  command: Command
  signal?: AbortSignal
  removeReady?: boolean
}) {
  const options = { env: ghEnv(repo.token, repo.host), signal }
  const output = await command(
    ['gh', 'issue', 'view', String(number), '-R', repo.path, '--json', 'labels'],
    options,
  )
  const parsed: unknown = JSON.parse(output)
  if (!Value.Check(labelsSchema, parsed)) throw new Error('Issue 标签格式无效')
  const names = parsed.labels.map((label) => label.name)
  const remove = [
    ...statuses.filter((status) => status !== target).map((status) => `workling:${status}`),
    ...(removeReady ? ['workling:ready'] : []),
  ].filter((label) => names.includes(label))
  const add = target ? `workling:${target}` : null
  const args = [
    ...remove.flatMap((label) => ['--remove-label', label]),
    ...(add && !names.includes(add) ? ['--add-label', add] : []),
  ]
  if (args.length)
    await command(['gh', 'issue', 'edit', String(number), '-R', repo.path, ...args], options)
}
