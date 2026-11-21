import { expect, test } from 'bun:test'
import { createPiEventFormatter } from '../worker/pi-events.ts'

test('工具开始格式化多行命令、截断、路径回退并隐藏密钥', () => {
  const f = createPiEventFormatter({ secrets: ['secret'], now: () => new Date(2026, 0, 1) })
  const event = (toolName: string, args: object) =>
    f(JSON.stringify({ type: 'tool_execution_start', toolCallId: '1', toolName, args }))
  expect(event('bash', { command: `secret${'x'.repeat(200)}\nnext` })[0]).toBe(
    `[pi 00:00:00] $ ***${'x'.repeat(194)}…（共 2 行）`,
  )
  expect(event('read', { path: 'a' })[0]).toContain('读 a')
  expect(event('read', { file_path: 'b' })[0]).toContain('读 b')
  expect(event('write', {})[0]).toContain('写 write')
  expect(event('edit', { path: 'c' })[0]).toContain('改 c')
  expect(event('other', {})[0]).toContain('调用 other')
})

test('工具更新按 30 秒节流，结束按错误与 10 秒阈值输出', () => {
  let ms = 0
  const f = createPiEventFormatter({ secrets: [], now: () => new Date(ms) })
  const send = (e: object) => f(JSON.stringify(e))
  send({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: {} })
  const update = {
    type: 'tool_execution_update',
    toolCallId: 'a',
    toolName: 'bash',
    partialResult: { content: [{ type: 'text', text: 'first\nlast\n' }] },
  }
  ms = 29999
  expect(send(update)).toEqual([])
  ms = 30000
  expect(send(update)[0]).toContain('已 30 秒）：last')
  ms = 60000
  expect(send(update)[0]).toContain('已 1 分 0 秒')
  expect(
    send({
      type: 'tool_execution_end',
      toolCallId: 'a',
      toolName: 'bash',
      isError: true,
      durationMs: 61000,
      result: { content: [{ type: 'text', text: '\nfailed\nnext' }] },
    })[0],
  ).toContain('失败（1 分 1 秒）：failed')
  expect(
    send({
      type: 'tool_execution_end',
      toolCallId: 'a',
      toolName: 'bash',
      isError: false,
      durationMs: 9999,
    }),
  ).toEqual([])
  expect(
    send({
      type: 'tool_execution_end',
      toolCallId: 'a',
      toolName: 'bash',
      isError: false,
      durationMs: 10000,
    })[0],
  ).toContain('完成（10 秒）')
})

test('助手文本、重试、压缩、非 JSON 和错误形状安全处理并隐藏密钥', () => {
  const f = createPiEventFormatter({ secrets: ['secret'], now: () => new Date(2026, 0, 1) })
  const send = (e: object) => f(JSON.stringify(e))
  expect(
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'secret\n\n' },
          { type: 'text', text: 'second' },
        ],
      },
    }),
  ).toEqual(['[pi 00:00:00] ***', '[pi 00:00:00] second'])
  expect(
    send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'error' })[0],
  ).toContain('第 1/3 次重试：error')
  expect(send({ type: 'auto_retry_end', success: false, finalError: 'error' })[0]).toContain(
    '重试失败：error',
  )
  expect(send({ type: 'compaction_start', reason: 'threshold' })[0]).toContain(
    '压缩上下文（threshold）',
  )
  expect(f('not json secret')).toEqual(['[pi 00:00:00] not json ***'])
  for (const e of [
    null,
    {},
    { type: 'tool_execution_start', args: null },
    { type: 'message_end', message: null },
  ])
    expect(f(JSON.stringify(e))).toEqual([])
})
