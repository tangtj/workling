import { expect, test } from 'bun:test'
import { createRunEvents, processRunEvents } from '../src/web/client/run-events.ts'
import type { TimelineItem } from '../src/web/timeline.ts'

type Batch = Parameters<typeof processRunEvents>[1]
const empty = { offset: 0, lines: [] }
const stream = (offset: number, ...lines: object[]) => ({
  offset,
  lines: lines.map((line) => JSON.stringify(line)),
})
const batch = (fields: Partial<Batch> = {}): Batch => ({
  ended: false,
  workling: empty,
  pi: empty,
  fallback: null,
  ...fields,
})
const ts = '2026-11-14T00:00:00.000Z'
const step = (text: string) => ({ type: 'step', ts, text })
const exit = { type: 'pi_exit', ts, code: 0, signal: null, durationMs: 1000 }
const start = {
  type: 'tool_execution_start',
  toolName: 'bash',
  toolCallId: '1',
  args: { command: 'ls' },
}
const end = { type: 'tool_execution_end', toolName: 'bash', toolCallId: '1', isError: false }
const fallback = (...lines: string[]) => ({ lines })

const cases: {
  name: string
  initiallyEnded?: boolean
  batches: {
    response: Batch
    items: Partial<TimelineItem>[]
    offsets: [number, number]
    stop?: boolean
    finishedWhileViewing?: boolean
    fallbackText?: string
  }[]
}[] = [
  {
    name: '两路偏移独立推进，增量追加并更新同一工具',
    batches: [
      {
        response: batch({ workling: stream(10, step('准备')), pi: stream(20, start) }),
        items: [
          { kind: 'step', text: '准备' },
          { kind: 'command', status: 'running' },
        ],
        offsets: [10, 20],
      },
      {
        response: batch({ workling: stream(10), pi: stream(40, end) }),
        items: [
          { kind: 'step', text: '准备' },
          { kind: 'command', status: 'ok' },
        ],
        offsets: [10, 40],
      },
      {
        response: batch({ workling: stream(20, step('核对')), pi: stream(40) }),
        items: [
          { kind: 'step', text: '准备' },
          { kind: 'command', status: 'ok' },
          { kind: 'step', text: '核对' },
        ],
        offsets: [20, 40],
      },
    ],
  },
  {
    name: 'pi_exit 与后续 workling 行等到后续 Pi 批次排空才应用',
    batches: [
      {
        response: batch({
          ended: true,
          workling: stream(10, step('准备'), exit, step('交付')),
          pi: stream(20, start),
        }),
        items: [{ kind: 'step' }, { kind: 'command', status: 'running' }],
        offsets: [10, 20],
      },
      {
        response: batch({ ended: true, workling: stream(10), pi: stream(30, end) }),
        items: [{ kind: 'step' }, { kind: 'command', status: 'ok' }],
        offsets: [10, 30],
      },
      {
        response: batch({ ended: true, workling: stream(10), pi: stream(30) }),
        items: [
          { kind: 'step' },
          { kind: 'command', status: 'ok' },
          { kind: 'exit', code: 0 },
          { kind: 'step', text: '交付' },
        ],
        offsets: [10, 30],
        stop: true,
        finishedWhileViewing: true,
      },
    ],
  },
  {
    name: 'fallback 每次以文本重建，恢复结构化事件后从空时间线开始',
    batches: [
      {
        response: batch({ fallback: fallback('old', ''), pi: stream(20, start) }),
        items: [{ kind: 'output', lines: ['old'] }],
        offsets: [0, 0],
        fallbackText: 'old\n',
      },
      {
        response: batch({ fallback: fallback('[pi 12:00:00] 新日志', 'new', '') }),
        items: [
          { kind: 'message', text: '新日志' },
          { kind: 'output', lines: ['new'] },
        ],
        offsets: [0, 0],
        fallbackText: '[pi 12:00:00] 新日志\nnew\n',
      },
      {
        response: batch({ workling: stream(10, step('准备')), pi: stream(20, start) }),
        items: [
          { id: 'event-0', kind: 'step' },
          { kind: 'command', status: 'running' },
        ],
        offsets: [10, 20],
      },
    ],
  },
  ...[false, true].map((initiallyEnded) => ({
    name: initiallyEnded
      ? '进入时已结束也要再取一次，排空后无需刷新详情'
      : '首次响应无新事件但已结束，仍需再取一次才刷新详情',
    initiallyEnded,
    batches: [
      { response: batch({ ended: true }), items: [], offsets: [0, 0] as [number, number] },
      {
        response: batch({ ended: true }),
        items: [],
        offsets: [0, 0] as [number, number],
        stop: true,
        finishedWhileViewing: !initiallyEnded,
      },
    ],
  })),
]

test.each(cases)('$name', ({ initiallyEnded, batches }) => {
  let current = createRunEvents(initiallyEnded ?? false)
  for (const { response, items, offsets, stop, finishedWhileViewing, fallbackText } of batches) {
    const before = structuredClone(current)
    const next = processRunEvents(current, response)
    expect(current).toEqual(before)
    expect(next.state.items).toHaveLength(items.length)
    expect(next.state.items).toMatchObject(items)
    expect([next.workling, next.pi]).toEqual(offsets)
    expect(next.ended).toBe(response.ended)
    expect(next.stop).toBe(stop ?? false)
    expect(next.finishedWhileViewing).toBe(finishedWhileViewing ?? false)
    expect(next.fallbackText).toBe(fallbackText ?? null)
    for (const item of next.state.calls.values())
      expect(next.state.items.find(({ id }) => id === item.id)).toBe(item)
    current = next
  }
})
