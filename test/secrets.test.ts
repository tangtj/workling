import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLlmSecrets, removeSecrets, writeLlmSecrets } from '../src/contract/secrets.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'workling-secrets-'))
  dirs.push(dir)
  return dir
}

const secrets = {
  baseUrl: 'https://llm.example/v1',
  apiKey: 'distinctive-fake-key',
  api: 'openai-responses',
} as const

test('写入后可读回，并收紧已有目录和文件的权限', async () => {
  const dir = await temp()
  const parent = join(dir, 'secrets')
  const file = join(parent, 'llm.json')
  await writeLlmSecrets(dir, secrets)
  expect((await stat(parent)).mode & 0o777).toBe(0o700)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await readLlmSecrets(dir)).toEqual(secrets)

  await chmod(parent, 0o755)
  await chmod(file, 0o644)
  const updated = { ...secrets, api: 'openai-completions' } as const
  await writeLlmSecrets(dir, updated)
  expect((await stat(parent)).mode & 0o777).toBe(0o700)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await readLlmSecrets(dir)).toEqual(updated)
})

test('缺少密钥文件时返回 null，删除密钥目录可重复执行', async () => {
  const dir = await temp()
  await removeSecrets(dir)
  expect(await readLlmSecrets(dir)).toBeNull()
  await writeLlmSecrets(dir, secrets)
  await removeSecrets(dir)
  await expect(stat(join(dir, 'secrets'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readLlmSecrets(dir)).toBeNull()
  await removeSecrets(dir)
})

test.each([
  ['无效 JSON', `{"apiKey":"${secrets.apiKey}",`],
  ['缺字段', JSON.stringify({ apiKey: secrets.apiKey, api: secrets.api })],
  ['地址为空', JSON.stringify({ ...secrets, baseUrl: '' })],
  ['密钥为空', JSON.stringify({ ...secrets, apiKey: '' })],
  ['API 取值不对', JSON.stringify({ ...secrets, api: 'other' })],
])('拒绝%s，错误不包含文件内容', async (_name, raw) => {
  const dir = await temp()
  await mkdir(join(dir, 'secrets'))
  await writeFile(join(dir, 'secrets', 'llm.json'), raw)
  const error = await readLlmSecrets(dir).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  expect(error).toHaveProperty('message', 'secrets/llm.json 无效')
  expect(error).not.toHaveProperty('cause')
})
