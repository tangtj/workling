import { expect, test } from 'bun:test'
import { add } from '../src/math.ts'

test('add 返回两数之和', () => {
  expect(add(1, 2)).toBe(3)
})
