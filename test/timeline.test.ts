import { expect, test } from 'bun:test'
import {
  createTimeline,
  applyWorklingLine,
  applyPiLine,
  applyLogLine,
  phaseOf,
  counts,
  shouldReload,
} from '../src/web/timeline.ts'

const ts = '2026-11-14T00:00:00.000Z'
const workling = (s: ReturnType<typeof createTimeline>, e: object) =>
  applyWorklingLine(s, JSON.stringify(e))
const pi = (s: ReturnType<typeof createTimeline>, e: object) => applyPiLine(s, JSON.stringify(e))
const content = (text: string) => ({ content: [{ type: 'text', text }] })

test('运行结束且事件排空后仅对初始运行中的页面刷新', () => {
  expect(shouldReload(false, true, true, false)).toBe(true)
  expect(shouldReload(true, true, true, false)).toBe(false)
  expect(shouldReload(false, true, false, false)).toBe(false)
  expect(shouldReload(false, true, true, true)).toBe(false)
  expect(shouldReload(false, false, false, false)).toBe(false)
})

test('两种事件流的超长行显示警告并计入错误', () => {
  const s = createTimeline()
  workling(s, { type: 'oversized_line', bytes: 1048577 })
  pi(s, { type: 'oversized_line', bytes: 2097152 })
  expect(s.items).toMatchObject([
    { kind: 'warning', text: '一条事件过大（1025 KB），已省略' },
    { kind: 'warning', text: '一条事件过大（2048 KB），已省略' },
  ])
  expect(counts(s).error).toBe(2)
  expect(phaseOf(s)).toBe(0)
})
function start(s: ReturnType<typeof createTimeline>, id: string, toolName: string, args: object) {
  pi(s, { type: 'tool_execution_start', toolCallId: id, toolName, args })
}
function end(s: ReturnType<typeof createTimeline>, id: string, isError = false, output = 'output') {
  pi(s, {
    type: 'tool_execution_end',
    toolCallId: id,
    toolName: 'bash',
    isError,
    durationMs: 1234,
    result: content(output),
  })
}

test('时间线生成每种 kind 及字段，按 toolCallId 原地更新并提取 codex 模型强度和最新行', () => {
  const s = createTimeline()
  workling(s, { type: 'step', ts, text: '拉起 Pi' })
  start(s, 'cmd', 'bash', { command: 'echo one\necho two' })
  start(s, 'codex', 'bash', {
    command: 'env -u GH_TOKEN codex exec -m "gpt-6" -c model_reasoning_effort="high" -',
  })
  const codex = s.items[2]
  pi(s, {
    type: 'tool_execution_update',
    toolCallId: 'codex',
    toolName: 'bash',
    partialResult: content('first\nlatest\n'),
  })
  expect(codex).toMatchObject({
    kind: 'codex',
    ts,
    model: 'gpt-6',
    effort: 'high',
    startedAt: ts,
    latest: 'latest',
    status: 'running',
  })
  end(s, 'cmd', false, 'x'.repeat(20001))
  end(s, 'codex', true)
  expect(s.items[2]).toBe(codex)
  expect(codex).toMatchObject({ status: 'error', durationMs: 1234, output: 'output' })
  expect(s.items[1]).toMatchObject({
    kind: 'command',
    command: 'echo one\necho two',
    status: 'ok',
    durationMs: 1234,
    output: 'x'.repeat(20000),
  })
  for (const [tool, args, action, path] of [
    ['read', { path: 'a' }, '读取', 'a'],
    ['write', { file_path: 'b' }, '写入', 'b'],
    ['edit', {}, '修改', 'edit'],
  ] as const) {
    start(s, tool, tool, args)
    expect(s.items.at(-1)).toMatchObject({ kind: 'file', action, path, status: 'running' })
  }
  start(s, 'tool', 'search', {})
  expect(s.items.at(-1)).toMatchObject({ kind: 'tool', name: 'search', status: 'running' })
  pi(s, { type: 'tool_execution_end', toolCallId: 'read', toolName: 'read', isError: true })
  expect(s.items[3]).toMatchObject({ status: 'error' })
  pi(s, {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'one' },
        { type: 'thinking', text: 'hidden' },
        { type: 'text', text: 'two' },
      ],
    },
  })
  expect(s.items.at(-1)).toMatchObject({ kind: 'message', text: 'onetwo' })
  pi(s, { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'busy' })
  expect(s.items.at(-1)).toMatchObject({
    kind: 'warning',
    text: '模型请求失败，第 1/3 次重试：busy',
  })
  pi(s, { type: 'auto_retry_end', success: false, finalError: 'failed' })
  expect(s.items.at(-1)).toMatchObject({ kind: 'warning', text: '重试失败：failed' })
  pi(s, { type: 'compaction_start', reason: 'threshold' })
  expect(s.items.at(-1)).toMatchObject({ kind: 'warning', text: '压缩上下文（threshold）' })
  workling(s, { type: 'pi_exit', ts, code: null, signal: 'SIGTERM', durationMs: 5000 })
  expect(s.items.at(-1)).toMatchObject({
    kind: 'exit',
    ts,
    code: null,
    signal: 'SIGTERM',
    durationMs: 5000,
  })
  expect(counts(s)).toEqual({ all: 12, command: 2, file: 3, message: 1, error: 5 })
  expect(new Set(s.items.map((i) => i.id)).size).toBe(s.items.length)
})

test('阶段按任意 Pi 事件、codex、结束后的命令和交付命令单调推进', () => {
  const s = createTimeline()
  expect(phaseOf(s)).toBe(0)
  workling(s, { type: 'step', ts, text: '准备' })
  pi(s, { type: 'agent_start' })
  expect(phaseOf(s)).toBe(1)
  start(s, 'c', 'bash', { command: 'codex exec -m model -c model_reasoning_effort=medium' })
  expect(phaseOf(s)).toBe(2)
  start(s, 'before', 'bash', { command: 'ls' })
  expect(phaseOf(s)).toBe(2)
  end(s, 'c')
  expect(phaseOf(s)).toBe(2)
  start(s, 'after', 'bash', { command: 'git diff' })
  expect(phaseOf(s)).toBe(3)
  start(s, 'push', 'bash', { command: 'git push -u origin HEAD' })
  expect(phaseOf(s)).toBe(4)
  pi(s, { type: 'agent_start' })
  expect(phaseOf(s)).toBe(4)
  const pr = createTimeline()
  start(pr, 'pr', 'bash', { command: 'gh pr create --title title' })
  expect(phaseOf(pr)).toBe(4)
})

test('时间线忽略坏行与错误形状、空说明和孤立更新，不覆盖其他工具', () => {
  const s = createTimeline()
  for (const line of ['bad', 'null', '[]', '{}', '{"type":4}']) {
    applyWorklingLine(s, line)
    applyPiLine(s, line)
  }
  expect(phaseOf(s)).toBe(0)
  for (const e of [
    { type: 'step', ts, text: 1 },
    { type: 'step', ts: 'bad', text: 'bad' },
    { type: 'pi_exit', ts, code: '0', signal: null, durationMs: 1 },
    { type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: null },
    { type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: { command: 1 } },
    { type: 'tool_execution_start', toolCallId: 'x', toolName: 'read', args: { path: 1 } },
    { type: 'message_end', message: { role: 'user', ...content('ignore') } },
    { type: 'message_end', message: { role: 'assistant', ...content('  ') } },
    { type: 'auto_retry_start', attempt: '1' },
    { type: 'compaction_start', reason: null },
  ]) {
    workling(s, e)
    pi(s, e)
  }
  expect(s.items).toEqual([])
  end(s, 'missing')
  expect(s.items).toEqual([])
  start(s, 'a', 'bash', { command: 'ls' })
  start(s, 'b', 'bash', { command: 'pwd' })
  end(s, 'b', true)
  pi(s, { type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', isError: 'false' })
  expect(s.items[0]).toMatchObject({ status: 'running' })
  expect(s.items[1]).toMatchObject({ status: 'error' })
})

test('错误形状的 Pi 事件不推进阶段也不修改时间基准', () => {
  const s = createTimeline()
  for (const event of [
    { type: 'tool_execution_start', timestamp: ts, toolCallId: 'x', toolName: 'bash', args: {} },
    { type: 'tool_execution_end', toolCallId: 'x', toolName: 'bash', isError: 'false' },
    { type: 'tool_execution_update', toolCallId: 1, toolName: 'bash' },
    { type: 'message_end', message: null },
    { type: 'auto_retry_start', attempt: '1', maxAttempts: 3, errorMessage: 'bad' },
    { type: 'auto_retry_end', success: false },
    { type: 'compaction_start', reason: 1 },
  ])
    pi(s, event)
  expect(s).toEqual(createTimeline())
})

test('文本日志解析 workling、退出码、信号和 pi 行，合并输出与连续空行，无法解析的结束保留原文', () => {
  const s = createTimeline()
  for (const line of [
    '[workling 12:00:00] 准备',
    '[pi 12:00:01] 说明',
    'one',
    '',
    '',
    'two',
    '[workling 12:00:02] Pi 被信号 SIGTERM 结束，用时 2 秒',
    '[workling 12:00:03] Pi 结束：未知',
  ])
    applyLogLine(s, line)
  expect(s.items).toMatchObject([
    { kind: 'step', ts: '12:00:00', text: '准备' },
    { kind: 'message', ts: '12:00:01', text: '说明' },
    { kind: 'output', lines: ['one', '', 'two'] },
    { kind: 'exit', signal: 'SIGTERM', durationMs: 2000 },
    { kind: 'exit', text: 'Pi 结束：未知' },
  ])
  expect(s.items.at(-1)).not.toHaveProperty('code')
  expect(phaseOf(s)).toBe(1)
  applyLogLine(s, '[workling 12:02:00] Pi 结束：退出码 0，用时 2 分 3 秒')
  expect(s.items.at(-1)).toMatchObject({ code: 0, durationMs: 123000 })
})

test('Issue #3 真实日志得到三个步骤、两个输出块及失败结束，保留凭证错误和文档路径', async () => {
  const s = createTimeline()
  const log = await Bun.file(new URL('./fixtures/issue-3-task.log', import.meta.url)).text()
  log
    .trimEnd()
    .split('\n')
    .forEach((line) => applyLogLine(s, line))
  expect(s.items.filter((i) => i.kind === 'step')).toHaveLength(3)
  expect(s.items.filter((i) => i.kind === 'step').map((i) => i.text)).toEqual([
    expect.stringContaining('克隆'),
    expect.stringContaining('配置 git'),
    expect.stringContaining('拉起 Pi'),
  ])
  const texts = s.items.flatMap((i) => ('text' in i && i.text !== undefined ? [i.text] : []))
  expect(new Set(texts).size).toBe(texts.length)
  const outputs = s.items.filter((i) => ['output'].includes(i.kind))
  expect(outputs).toHaveLength(2)
  expect(outputs[0]).toMatchObject({ lines: [expect.stringContaining('正克隆到 ')] })
  expect(outputs[1]).toMatchObject({
    lines: expect.arrayContaining([
      'No API key found for the selected model.',
      '  /home/dev/workling/node_modules/@earendil-works/pi-coding-agent/docs/providers.md',
      '  /home/dev/workling/node_modules/@earendil-works/pi-coding-agent/docs/models.md',
    ]),
  })
  expect(s.items.filter((i) => i.kind === 'exit')).toEqual([
    expect.objectContaining({ code: 1, durationMs: 1000, ts: '22:00:49' }),
  ])
})
