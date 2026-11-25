import { expect, test } from 'bun:test'
import { sumRange } from '../src/range.ts'

test('sumRange 返回包含两端的整数和', () => {
  expect(sumRange(1, 3)).toBe(6)
})
