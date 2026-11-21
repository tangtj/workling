import { expect, test } from 'bun:test'
import { maxCommentLength, truncateComment } from '../src/contract/out.ts'
import { AI_NOTICE, markComment } from '../src/serve/comment.ts'

test('评论末尾显示 AI 标识并保留隐藏标记', () => {
  expect(markComment('x')).toBe(`x\n\n\n${AI_NOTICE}\n\n<!-- workling -->`)
})

test('超长评论截断后仍保留完整标识', () => {
  const body = truncateComment('x'.repeat(maxCommentLength + 1))
  expect(body.length).toBeLessThanOrEqual(maxCommentLength)
  expect(markComment(body)).toEndWith(`\n\n\n${AI_NOTICE}\n\n<!-- workling -->`)
})
