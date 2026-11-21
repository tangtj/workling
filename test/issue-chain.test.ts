import { expect, test } from 'bun:test'
import { previousSibling, readParent, readSubIssues } from '../src/issue/chain.ts'
import type { Command } from '../src/runtime/types.ts'

const repo = { path: 'owner/repo', token: 'token', host: 'github.com' }
const signal = new AbortController().signal

test('保留 GitHub 子 Issue 顺序并识别同仓库', async () => {
  const command: Command = async () =>
    JSON.stringify(
      [2, 1].map((number) => ({
        number,
        title: '',
        state: 'open',
        state_reason: null,
        repository_url: 'https://api.github.com/repos/OWNER/REPO',
      })),
    )
  const subs = await readSubIssues({ repo, number: 3, command, signal })
  expect(subs.map((sub) => sub.number)).toEqual([2, 1])
  expect(subs.every((sub) => sub.sameRepo)).toBe(true)
})
test('父 Issue 返回 404 时视为没有父 Issue', async () => {
  const command: Command = async () => {
    throw new Error('gh: HTTP 404')
  }
  expect(await readParent({ repo, number: 1, command, signal })).toBeUndefined()
})
test('查找上一个兄弟时跳过不计划的项目', () => {
  const subs = [1, 2, 3].map((number) => ({
    number,
    title: '',
    state: number === 2 ? ('closed' as const) : ('open' as const),
    stateReason: number === 2 ? 'not_planned' : null,
    sameRepo: true,
  }))
  expect(previousSibling(subs, 3)?.number).toBe(1)
  expect(previousSibling(subs, 1)).toBeUndefined()
  expect(previousSibling(subs, 4)).toBeUndefined()
})
