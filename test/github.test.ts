import { expect, test } from 'bun:test'
import { clearDefaultBranchCache, defaultBranch } from '../src/platform/github.ts'
import type { Command } from '../src/runtime/types.ts'

test('默认分支缓存成功结果，清除后重新请求，非法结果不缓存', async () => {
  const repo = { host: 'github.com', path: 'a/b', token: 'token' }
  let result = 'main'
  let calls = 0
  const command: Command = async (args, options) => {
    calls++
    expect(args).toEqual(['gh', 'api', 'repos/a/b', '--jq', '.default_branch'])
    expect(options?.env).toMatchObject({ GH_TOKEN: 'token', GH_HOST: 'github.com' })
    return result
  }
  expect(await defaultBranch({ repo, command })).toBe('main')
  expect(await defaultBranch({ repo, command })).toBe('main')
  expect(calls).toBe(1)
  clearDefaultBranchCache()
  result = ''
  await expect(defaultBranch({ repo, command })).rejects.toThrow('默认分支无效')
  result = 'main'
  expect(await defaultBranch({ repo, command })).toBe('main')
  expect(calls).toBe(3)
})
