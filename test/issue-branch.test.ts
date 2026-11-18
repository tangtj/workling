import { expect, test } from 'bun:test'
import { docBranch, shortName, taskBranch } from '../src/issue/branch.ts'

test.each([
  ['Fix 42：解析 _JSON_', 'fix-42-json'],
  ['', 'task'],
  ['修复：K 🚀', 'task'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'abcdefghijklmnopqrstuvwxyz0123'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZ012 next', 'abcdefghijklmnopqrstuvwxyz012'],
])('标题 %j 生成短名 %j', (title, expected) => {
  expect(shortName(title)).toBe(expected)
})

test('任务分支组合 Issue 编号与短名', () => {
  expect(taskBranch(42, 'Checkout docs')).toBe('workling/42-checkout-docs')
})

test.each([
  ['分支：docs/first\n分支：docs/second', 'docs/first'],
  ['说明\r\n  分支： Docs/v1.2_beta-3 \t\r\n', 'Docs/v1.2_beta-3'],
  ['```md\n分支：-invalid\n```\n分支：docs/real', 'docs/real'],
  ['~~~~\n~~~\n分支：-invalid\n~~~~\n分支：docs/real', 'docs/real'],
  ['<!--\n```\n分支：-invalid\n-->\n分支：docs/real', 'docs/real'],
  ['```\n<!--\n分支：-invalid\n```\n分支：docs/real', 'docs/real'],
  ['<!-- 注释结束 --> <!--\n分支：-invalid\n-->\n分支：docs/real', 'docs/real'],
])('从 %j 读取文档分支 %s', (body, name) => {
  expect(docBranch(body)).toEqual({ name })
})

test.each([
  '正文在行中间写分支：docs/example',
  '分支:docs/example',
  '```\n分支：docs/example\n```',
  '~~~markdown\n分支：docs/example',
  '<!-- 分支：docs/example -->',
  '介绍 <!--\n分支：docs/example\n-->',
])('忽略 %j 中的示例', (body) => {
  expect(docBranch(body)).toBeUndefined()
})

test.each([
  '',
  '-docs',
  'docs/has space',
  'docs/a..b',
  'docs//a',
  'docs/',
  '/docs',
  'docs/.hidden',
  'docs/pending.lock/next',
  'docs/trailing.',
  'HEAD',
  '@{-1}',
  '文档',
])('报告第一个分支名 %j 无效', (name) => {
  expect(docBranch(`分支：${name}\n分支：docs/valid`)).toHaveProperty('error')
})
