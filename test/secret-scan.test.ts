import { expect, test } from 'bun:test'
import { findSecrets } from '../src/serve/secret-scan.ts'

test.each([
  ['GitHub token', `ghp_${'a'.repeat(36)}`, []],
  ['GitHub token', `ghs_${'a'.repeat(40)}`, []],
  ['GitHub token', 'github_pat_some_credential', []],
  ['Private key', '-----BEGIN OPENSSH PRIVATE KEY-----', []],
  ['Private key', '-----BEGIN PRIVATE KEY-----', []],
  ['AWS Access Key', 'AKIAABCDEFGHIJKLMNOP', []],
  ['API key', `sk-${'a'.repeat(20)}`, []],
  ['Configured secret', 'literal.value[1]', ['literal.value[1]']],
] as const)('新增行命中 %s，结果只含规则及文件', (rule, value, extra) => {
  const hits = findSecrets(`+++ b/config.txt\n@@ -1 +1 @@\n+key=${value}\n`, [...extra])
  expect(hits).toEqual([{ rule, file: 'config.txt' }])
  expect(JSON.stringify(hits)).not.toContain(value)
})

test('只扫描新增行，跳过文件头、删除行、上下文和空字面值', () => {
  const key = `sk-${'a'.repeat(20)}`
  expect(findSecrets(`+++ b/${key}\n@@ -1,2 +1,2 @@\n-${key}\n ${key}\n+ordinary`, [''])).toEqual(
    [],
  )
  expect(findSecrets(`+++ b/config.txt\n@@ -0,0 +1 @@\n+++ ${key}`, [])).toEqual([
    { rule: 'API key', file: 'config.txt' },
  ])
})
