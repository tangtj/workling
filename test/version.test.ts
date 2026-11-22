import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions,
  isPrerelease,
  readVersion,
  validVersion,
  isEdge,
} from '../src/runtime/version.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test('SemVer 比较 dev、预发布、数字段、ASCII、段数与超大整数', () => {
  const pairs = [
    ['dev', 'v0.0.0'],
    ['v1.0.0-rc.1', 'v1.0.0'],
    ['v1.0.0-rc.2', 'v1.0.0-rc.10'],
    ['v1.0.0-alpha', 'v1.0.0-beta'],
    ['v1.0.0-alpha', 'v1.0.0-alpha.1'],
    ['v1.0.0-1', 'v1.0.0-alpha'],
    ['v1.0.0-A', 'v1.0.0-a'],
    ['v9007199254740992.0.0', 'v9007199254740993.0.0'],
    ['v1.0.0-9007199254740992', 'v1.0.0-9007199254740993'],
    ['v1.0.0', 'v1.0.1-alpha'],
    ['v1.0.0-alpha-1', 'v1.0.0-alpha-2'],
  ]
  for (const [left, right] of pairs) {
    expect(compareVersions(left!, right!)).toBe(-1)
    expect(compareVersions(right!, left!)).toBe(1)
    expect(compareVersions(left!, left!)).toBe(0)
  }
  expect(compareVersions('dev', 'dev')).toBe(0)
  expect(compareVersions('v1.0.0+build.1', 'v1.0.0+build.2')).toBe(0)
  expect(isPrerelease('v1.0.0-rc.1')).toBe(true)
  expect(isPrerelease('v1.0.0')).toBe(false)
  expect(isPrerelease('dev')).toBe(false)
})

test('readVersion 只读取 VERSION，缺失或空白时返回 dev', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-version-'))
  dirs.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  expect(readVersion(dir)).toBe('dev')
  await writeFile(join(dir, 'VERSION'), '  \n')
  expect(readVersion(dir)).toBe('dev')
  await writeFile(join(dir, 'VERSION'), 'v1.2.3\n')
  expect(readVersion(dir)).toBe('v1.2.3')
})

test('版本格式接受 tag 与小写 edge，不接受 dev 或非法值', () => {
  for (const [value, valid, edge] of [
    ['v1.2.3', true, false],
    ['edge-012345abcdef', true, true],
    ['dev', false, false],
    ['edge-012345ABCDEF', false, false],
    ['edge-123', false, false],
    ['../bad', false, false],
  ] as const) {
    expect(validVersion(value)).toBe(valid)
    expect(isEdge(value)).toBe(edge)
  }
})
