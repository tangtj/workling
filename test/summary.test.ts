import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractSummary,
  reportExcerpt,
  reportOutcome,
  reportResultLine,
} from '../src/task/summary.ts'

test.each([
  ['# 结果\n\n部分完成。尚不能…', '部分完成。尚不能…', 'partial'],
  ['###### 结果：\r\n\r\n  - 完成，检查通过。  ', '完成，检查通过。', 'completed'],
  ['## 结果:\n* 未完成，检查失败。', '未完成，检查失败。', 'incomplete'],
  ['- 结果：完成', '完成', 'completed'],
  ['结果：未完成', '未完成', 'incomplete'],
  ['没有结果字段', undefined, 'incomplete'],
  ['结果：未知', '未知', 'incomplete'],
] as const)('报告结果 %j 提取内容并判定为 %s / %s', (report, line, outcome) => {
  expect(reportResultLine(report)).toBe(line)
  expect(reportOutcome(report)).toBe(outcome)
})

test.each([
  ['标题直到同级标题', ['## 未完成与存疑', '待确认', '### 细节', '仍需复查'], '## 其他'],
  ['标题直到更高级标题', ['##未完成与存疑：', '待确认'], '# 其他'],
  ['列表直到顶层列表项', ['- 未完成与存疑：待确认', '  - 细节：复查'], '- 其他：'],
  ['列表直到标题', ['- 未完成与存疑：', '  待确认'], '# 其他'],
] as const)('长报告摘录保留未完成与存疑小节：%s', (_kind, section, boundary) => {
  const intro = Array.from({ length: 45 }, (_, i) => `第 ${i + 1} 行`)
  const report = [...intro, ...section, boundary, '其他内容'].join('\n')
  expect(reportExcerpt(report)).toBe([...intro.slice(0, 15), '…', ...section].join('\n'))
})

test('报告摘录原样保留短报告，超长时限制小节或回退到前 40 行', () => {
  const lines = Array.from({ length: 45 }, (_, i) => `第 ${i + 1} 行`)
  const short = `${lines.slice(0, 40).join('\r\n')}\r\n`
  expect(reportExcerpt(short)).toBe(short)
  expect(reportExcerpt(lines.join('\n'))).toBe(lines.slice(0, 40).join('\n'))
  const section = ['## 未完成与存疑', ...lines]
  expect(reportExcerpt([...lines, ...section].join('\n'))).toBe(
    [...lines.slice(0, 15), '…', ...section.slice(0, 40)].join('\n'),
  )
})

test('摘要提取最后助手消息、多文本块、报告结果与日志并打码', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-summary-'))
  try {
    expect(await extractSummary(dir, [])).toEqual({
      summary: null,
      reportResult: null,
      logTail: null,
    })
    const event = (text: string) =>
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }, { type: 'image' }, { type: 'text', text: 'secret' }],
        },
      })
    await writeFile(join(dir, 'pi-events.jsonl'), `${event('旧')}\n坏行\n${event('新')}\n`)
    await writeFile(join(dir, 'report.md'), '结果： secret\n- 结果: 第二个')
    await writeFile(join(dir, 'task.log'), '日志 secret\n')
    expect(await extractSummary(dir, ['secret', ''])).toEqual({
      summary: '新***',
      reportResult: '***',
      logTail: '日志 ***',
    })
    await writeFile(join(dir, 'report.md'), '- 结果: 完成')
    expect((await extractSummary(dir, [])).reportResult).toBe('完成')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('摘要限制 4000、报告限制 50、日志取最后 50 行及最后 8000 字符', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-summary-limit-'))
  try {
    await writeFile(
      join(dir, 'pi-events.jsonl'),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(4001) }] },
      }),
    )
    await writeFile(join(dir, 'report.md'), `结果：${'b'.repeat(51)}`)
    await writeFile(
      join(dir, 'task.log'),
      `discard\n${Array(50).fill('c'.repeat(200)).join('\n')}\n`,
    )
    const result = await extractSummary(dir, [])
    expect(result.summary).toBe(`${'a'.repeat(4000)}…`)
    expect(result.reportResult).toBe('b'.repeat(50))
    expect(result.logTail).toBe(Array(50).fill('c'.repeat(200)).join('\n').slice(-8000))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
