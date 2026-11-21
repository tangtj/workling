import { expect, test } from 'bun:test'
import {
  filterIssues,
  stageCounts,
  selectedStage,
  stageFromParams,
  matchesStage,
  queuePositions,
  sortIssues,
  stageText,
  failureReason,
  type IssueRow,
} from '../src/web/issue-view.ts'

const run = { startedAt: new Date(0), endedAt: new Date(120000), exitCode: 0, error: null }
const rows: (IssueRow & { stage: IssueRow['status'] })[] = [
  {
    id: 1,
    repoId: 1,
    number: 10,
    title: 'Alpha task',
    status: 'queued',
    stage: 'queued',
    updatedAt: new Date(1000),
    runCount: 0,
    lastRun: null,
  },
  {
    id: 2,
    repoId: 2,
    number: 20,
    title: 'Beta',
    status: 'running',
    stage: 'running',
    updatedAt: new Date(2000),
    runCount: 1,
    lastRun: run,
  },
  {
    id: 3,
    repoId: 1,
    number: 30,
    title: null,
    status: 'queued',
    stage: 'queued',
    updatedAt: new Date(3000),
    runCount: 0,
    lastRun: null,
  },
]
test('按标题、编号和仓库筛选，统计状态并按运行状态和时间排序', () => {
  for (const [repo, q, ids] of [
    [undefined, 'ALPHA', [1]],
    [undefined, '#10', [1]],
    [undefined, '10', [1]],
    [undefined, '#x', []],
    [1, '', [1, 3]],
    [2, 'alpha', []],
  ] as const)
    expect(filterIssues(rows, repo, q).map((i) => i.id)).toEqual([...ids])
  expect(stageCounts(rows)).toEqual({
    all: 3,
    attention: 0,
    queued: 2,
    running: 1,
    rework: 0,
    review: 0,
    capped: 0,
    failed: 0,
    done: 0,
    canceled: 0,
  })
  expect([...queuePositions(rows)]).toEqual([
    [1, 1],
    [3, 2],
  ])
  expect(sortIssues(rows).map((i) => i.id)).toEqual([2, 3, 1])
})
test('阶段文案和失败原因覆盖不同结果', () => {
  const base = rows[0]!
  for (const [issue, text] of [
    [base, '队列第 1 位'],
    [{ ...base, status: 'running', lastRun: run }, '已运行 3 分钟'],
    [{ ...base, status: 'done', lastRun: run }, '用时 2 分钟'],
    [{ ...base, status: 'canceled', lastRun: run }, '已取消'],
    [{ ...base, status: 'failed', lastRun: { ...run, error: '超时' } }, '超时'],
    [{ ...base, status: 'done' }, '尚未执行'],
  ] as Array<[IssueRow, string]>)
    expect(stageText(issue, 180000, queuePositions(rows))).toBe(text)
  for (const [error, label] of [
    ['超时', '超时'],
    ['已取消', '已取消'],
    ['进程中断', '进程丢失'],
    ['内存不足（OOM）', '内存不足'],
    ['未找到 PR', '未建 PR'],
    ['other', '失败'],
  ] as const)
    expect(failureReason({ lastRun: { ...run, error } }).label).toBe(label)
  expect(failureReason({ lastRun: { ...run, exitCode: 7 } }).label).toBe('退出码 7')
})

test('阶段筛选兼容旧状态并区分待处理与上限', () => {
  expect(stageFromParams(new URLSearchParams('status=failed'))).toBe('failed')
  expect(stageFromParams(new URLSearchParams('stage=capped&status=failed'))).toBe('capped')
  expect(stageFromParams(new URLSearchParams('status=attention'))).toBe('all')
  expect(selectedStage('failed')).toBe('failed')
  expect(selectedStage('invalid')).toBe('all')
  expect(matchesStage('capped', selectedStage('capped'))).toBe(true)
  expect(matchesStage('failed', selectedStage('capped'))).toBe(false)
  expect(matchesStage('capped', 'attention')).toBe(true)
  expect(matchesStage('failed', 'attention')).toBe(true)
  expect(matchesStage('review', 'attention')).toBe(false)
})
