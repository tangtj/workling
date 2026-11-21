import { expect, test } from 'bun:test'
import { issueStage, type Stage } from '../src/web/stage.ts'

test('按状态、运行类型、PR 和最近结束后的反馈派生阶段', () => {
  const base: Parameters<typeof issueStage>[0] = {
    status: 'done',
    prState: 'open',
    lastRun: { kind: 'implement', endedAt: new Date(2000) },
    cappedFeedbackAt: [],
  }
  const cases: Array<[Parameters<typeof issueStage>[0], Stage]> = [
    [{ ...base, status: 'running' }, 'running'],
    [{ ...base, status: 'running', lastRun: null }, 'running'],
    [
      { ...base, status: 'running', lastRun: { kind: 'rework', endedAt: new Date(2000) } },
      'rework',
    ],
    [{ ...base, status: 'queued' }, 'queued'],
    [{ ...base, status: 'failed' }, 'failed'],
    [{ ...base, status: 'canceled' }, 'canceled'],
    [{ ...base, cappedFeedbackAt: [new Date(3000)] }, 'capped'],
    [{ ...base, lastRun: null, cappedFeedbackAt: [new Date(1000)] }, 'capped'],
    [
      {
        ...base,
        lastRun: { kind: 'implement', endedAt: null },
        cappedFeedbackAt: [new Date(1000)],
      },
      'capped',
    ],
    [{ ...base, cappedFeedbackAt: [new Date(1000), new Date(2000)] }, 'review'],
    [base, 'review'],
    ...([null, 'merged', 'closed'] as const).map(
      (prState): [Parameters<typeof issueStage>[0], Stage] => [
        { ...base, prState, cappedFeedbackAt: [new Date(3000)] },
        'done',
      ],
    ),
  ]
  for (const [input, expected] of cases) expect(issueStage(input)).toBe(expected)
})
