import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'

export const llmSecretsSchema = Type.Object({
  baseUrl: Type.String({ minLength: 1 }),
  apiKey: Type.String({ minLength: 1 }),
  api: Type.Union([Type.Literal('openai-responses'), Type.Literal('openai-completions')]),
})

export type LlmSecrets = Type.Static<typeof llmSecretsSchema>

export async function writeLlmSecrets(dir: string, secrets: LlmSecrets): Promise<void> {
  const parent = join(dir, 'secrets')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700)
  const tmp = join(parent, 'llm.json.tmp')
  await writeFile(tmp, JSON.stringify(secrets), { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, join(parent, 'llm.json'))
}

export async function readLlmSecrets(dir: string): Promise<LlmSecrets | null> {
  let raw: string
  try {
    raw = await readFile(join(dir, 'secrets', 'llm.json'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw new Error('secrets/llm.json 无效')
  }
  let secrets: unknown
  try {
    secrets = JSON.parse(raw)
  } catch {
    // JSON 解析错误可能带原文片段，不能传给任务日志。
    throw new Error('secrets/llm.json 无效')
  }
  if (!Value.Check(llmSecretsSchema, secrets)) throw new Error('secrets/llm.json 无效')
  return secrets
}

export async function removeSecrets(dir: string): Promise<void> {
  await rm(join(dir, 'secrets'), { recursive: true, force: true })
}
