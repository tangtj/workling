import { expect, test } from 'bun:test'
import { greet } from '../src/greet.ts'

test('greet 返回问候语', () => {
  expect(greet('Ada')).toBe('Hello, Ada!')
})

test('greet 对空名字使用 stranger', () => {
  expect(greet('  ')).toBe('Hello, stranger!')
})
