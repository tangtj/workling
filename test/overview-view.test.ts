import { expect, test } from 'bun:test'
import {
  overviewModel,
  runResult,
  slotTiming,
  type OverviewIssue,
} from '../src/web/overview-view.ts'

const now = 100000000
const make = (
  id: number,
  status: OverviewIssue['status'],
  updated: number,
  ended: number | null,
): OverviewIssue => ({
  id,
  repoId: 1,
  repoRef: 'github:a/b',
  number: id,
  title: null,
  status,
  updatedAt: new Date(updated),
  runCount: 1,
  lastRun: {
    id,
    startedAt: new Date(updated),
    endedAt: ended === null ? null : new Date(ended),
    exitCode: 0,
    error: null,
  },
  runs: [
    {
      id,
      startedAt: new Date(updated),
      endedAt: ended === null ? null : new Date(ended),
      exitCode: 0,
      error: null,
    },
  ],
})
test('概览排序、时间窗口、平均值和空闲名额', () => {
  const items = [
    make(1, 'running', 20, null),
    make(2, 'running', 10, null),
    make(3, 'queued', 30, null),
    make(4, 'queued', 5, null),
    make(5, 'failed', 20, now),
    make(6, 'failed', 30, now - 86400000),
    make(7, 'done', 0, now - 86400001),
    make(8, 'done', 0, now + 1),
  ]
  const model = overviewModel(items, now, 3)
  expect(model.running.map((i) => i.id)).toEqual([2, 1])
  expect(model.queued.map((i) => i.id)).toEqual([4, 3])
  expect(model.failed.map((i) => i.id)).toEqual([6, 5])
  expect(model.recent.map((i) => i.issue.id)).toEqual([5, 6])
  expect(model.meanMs).toBe((now - 20 + (now - 86400000 - 30)) / 2)
  expect(model.idle).toBe(1)
  expect(overviewModel([], now, 0).meanMs).toBeNull()
  expect(overviewModel(items, now, 1).idle).toBe(0)
})
test('执行时间边界和运行结果', () => {
  for (const [elapsed, timeout, hot, remaining] of [
    [480, 10, false, 2],
    [481, 10, true, 2],
    [599, 10, true, 1],
    [601, 10, true, 0],
    [1, null, false, null],
  ] as const) {
    const result = slotTiming(new Date(now - elapsed * 1000), now, timeout)
    expect(result.hot).toBe(hot)
    expect(result.remainingMinutes).toBe(remaining)
  }
  const run = make(1, 'done', 0, now).runs[0]!
  for (const [endedAt, exitCode, error, expected] of [
    [null, 0, null, 'running'],
    [new Date(now), 0, null, 'done'],
    [new Date(now), 1, null, 'failed'],
    [new Date(now), 0, 'error', 'failed'],
  ] as const)
    expect(runResult({ ...run, endedAt, exitCode, error })).toBe(expected)
})
