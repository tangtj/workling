import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTRACT_VERSION, readSpec, writeSpec, type Spec } from '../src/contract/spec.ts'

const spec: Spec = {
  contract: CONTRACT_VERSION,
  kind: 'implement',
  issue: { ref: 'github:a/b#12', title: '测试 Issue' },
  repo: { baseRef: 'a'.repeat(40), branch: 'workling/12-issue' },
  model: { codex: 'test-codex', effort: 'high', pi: 'test-pi' },
  git: { name: 'test-bot', email: 'bot@example.com' },
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workling-spec-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('writeSpec 写入权限为 0600 的契约，readSpec 返回原值', async () => {
  await writeSpec(dir, spec)
  expect(await readSpec(dir)).toEqual(spec)
  expect(await readdir(dir)).toEqual(['spec.json'])
  expect((await stat(join(dir, 'spec.json'))).mode & 0o777).toBe(0o600)
})

test.each([
  ['文件缺失', undefined, '缺少 spec.json'],
  ['不是 JSON', '{"contract":', 'spec.json 不是有效的 JSON'],
  ['字段缺失', JSON.stringify({ ...spec, git: undefined }), 'spec.json 的结构无效'],
  ['工作副本字段缺失', JSON.stringify({ ...spec, repo: undefined }), 'spec.json 的结构无效'],
  ['版本不支持', JSON.stringify({ ...spec, contract: 2 }), 'spec.json 的契约版本不受支持'],
] as const)('readSpec 在%s时报告原因', async (_kind, raw, error) => {
  if (raw !== undefined) await writeFile(join(dir, 'spec.json'), raw)
  await expect(readSpec(dir)).rejects.toThrow(error)
})
