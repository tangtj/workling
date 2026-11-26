import { expect, test } from 'bun:test'
import { maxCommentLength, truncateComment } from '../src/contract/out.ts'
import { runs } from '../src/db/schema.ts'
import {
  AI_NOTICE,
  formatDuration,
  markComment,
  normalizeBody,
  runComment,
  runRound,
} from '../src/serve/comment.ts'
import { clock, scenario } from './helpers/serve.ts'

test('评论末尾显示 AI 标识并保留隐藏标记', () => {
  expect(markComment('x')).toBe(`x\n\n\n${AI_NOTICE}\n\n<!-- workling -->`)
})

test('超长评论截断后仍保留完整标识', () => {
  const body = truncateComment('x'.repeat(maxCommentLength + 1))
  expect(body.length).toBeLessThanOrEqual(maxCommentLength)
  expect(markComment(body)).toEndWith(`\n\n\n${AI_NOTICE}\n\n<!-- workling -->`)
})

test('运行评论按顺序用空行分隔各部分，省略空白部分对应的分隔', () => {
  expect(
    runComment({ title: '标题', facts: ['甲', '乙'], body: '正文', tail: '附录', next: '后续' }),
  ).toBe('### 标题\n\n甲 · 乙\n\n正文\n\n附录\n\n**下一步**：后续')
  expect(runComment({ title: '标题', facts: [] })).toBe('### 标题')
  expect(runComment({ title: '标题', facts: [], body: '', next: '后续' })).toBe(
    '### 标题\n\n**下一步**：后续',
  )
})

test('运行评论只截断超长正文，保留完整字符、附录和下一步', () => {
  const parts = { title: '标题', facts: ['事实'], tail: '完整附录', next: '完整下一步' }
  const fixedLength = runComment(parts).length + '\n\n\n\n（已截断）'.length
  const limit = maxCommentLength - fixedLength
  const body = '甲'.repeat(limit - 1) + '🙂'.repeat(10)
  const comment = runComment({ ...parts, body })
  expect(comment.length).toBe(maxCommentLength - 1)
  expect(comment).toBe(
    `### 标题\n\n事实\n\n${'甲'.repeat(limit - 1)}\n\n（已截断）\n\n完整附录\n\n**下一步**：完整下一步`,
  )
})

test('正文只移除开头的结果前缀，并整理围栏外的标题与连续换行', () => {
  const fences = ['````md\n# 保留\n\n\n```\n### 也保留\n````', '~~~\n# 保留\n\n\n~~~'].join('\n\n')
  expect(
    normalizeBody(
      `  交付结果：完成。说明保留\n\n\n## 改动 ##\n\n   ### **检查**\n\n${fences}\n\n\n交付结果：未完成  `,
    ),
  ).toBe(`说明保留\n\n**改动**\n\n**检查**\n\n${fences}\n\n交付结果：未完成`)
  expect(normalizeBody('  结果:部分完成.还有一项')).toBe('还有一项')
})

test.each([
  [0, '用时 1 分钟'],
  [5_000, '用时 1 分钟'],
  [58 * 60_000 + 1, '用时 59 分钟'],
  [120 * 60_000, '用时 2 小时'],
  [(13 * 60 + 37) * 60_000, '用时 13 小时 37 分钟'],
])('用时 %i 毫秒向上取整并按小时和分钟展示', (ms, expected) => {
  expect(formatDuration(clock, new Date(clock.getTime() + ms))).toBe(expected)
})

test('轮次按同一 Issue 的运行编号计算，跳过评审和排在后面的运行', async () => {
  const s = await scenario()
  try {
    const issue = await s.issue()
    const other = await s.issue(43)
    const addRun = (issueId: number, kind: typeof runs.$inferSelect.kind) =>
      s.db
        .insert(runs)
        .values({ issueId, kind, startedAt: clock, worker: 'test' })
        .returning()
        .get()
    const first = addRun(issue.id, 'plan')
    addRun(other.id, 'implement')
    addRun(issue.id, 'review')
    const second = addRun(issue.id, 'implement')
    addRun(issue.id, 'rework')
    expect(runRound(s.db, issue.id, first.id)).toBe(1)
    expect(runRound(s.db, issue.id, second.id)).toBe(2)
  } finally {
    await s.dispose()
  }
})
