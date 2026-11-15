import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractSummary } from '../src/task/summary.ts'

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
