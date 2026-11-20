import { expect, test } from 'bun:test'
import { formatDuration, formatTime, prLabel, relativeTime } from '../src/web/format.ts'

test('格式化本地时间、时长、相对时间和 PR 编号', () => {
  const now = new Date(2026, 10, 14, 12, 30).getTime()
  expect(formatTime(new Date(2026, 10, 14, 9, 5), now)).toBe('09:05')
  expect(formatTime(new Date(2026, 10, 13, 9, 5), now)).toBe('11-13 09:05')
  expect(formatDuration(59999)).toBe('不到 1 分钟')
  expect(formatDuration(61 * 60000)).toBe('1 小时 1 分钟')
  expect(relativeTime(new Date(now - 5 * 60000), now)).toBe('5 分钟前')
  expect(relativeTime(new Date(now - 120 * 60000), now)).toBe('2 小时前')
  expect(prLabel('https://github.com/a/b/pull/57')).toBe('#57')
})
