import { expect, test } from 'bun:test'
import { clamp } from '../src/range.ts'

test('clamp 将值限制在指定范围内', () => {
  expect(clamp(-1, 0, 5)).toBe(0)
  expect(clamp(2, 0, 5)).toBe(2)
  expect(clamp(6, 0, 5)).toBe(5)
})
