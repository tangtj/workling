import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readExecution,
  readOutResult,
  readPiOutcome,
  readPlan,
  readReview,
  writeOutResult,
  type OutResult,
  type Plan,
  type Review,
} from '../src/contract/out.ts'

const finding = {
  severity: 'blocker',
  path: 'src/range.ts',
  line: 6,
  scenario: 'start 大于 end',
  body: '应当返回 0',
  known: false,
} as const

const review: Review = {
  verdict: 'changes',
  summary: '检查通过，但反向范围不满足验收。',
  checks: [{ command: 'bun test', passed: true, detail: '' }],
  acceptance: [{ item: '反向范围返回 0', met: 'no', evidence: 'sumRange(3, 1) 返回 6' }],
  findings: [finding],
}

test('out/result.json 原子写入，并分别报告缺文件、无效 JSON、错误结构和错误版本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-out-'))
  try {
    await expect(readOutResult(dir)).rejects.toThrow('缺少 out/result.json')
    const result = {
      contract: 2,
      outcome: 'completed',
      branch: 'workling/42-task',
      head: null,
      commits: 0,
    } satisfies OutResult
    await writeOutResult(dir, result)
    expect(await readOutResult(dir)).toEqual(result)
    expect(await readdir(dir)).toEqual(['result.json'])
    for (const [data, error] of [
      ['{', '不是有效的 JSON'],
      [JSON.stringify({ ...result, commits: -1 }), '结构无效'],
      [JSON.stringify({ ...result, contract: 3 }), '契约版本不受支持'],
    ] as const) {
      await writeFile(join(dir, 'result.json'), data)
      await expect(readOutResult(dir)).rejects.toThrow(error)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readReview 校验评审内容并拒绝符号链接和超出大小限制的文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-review-'))
  const path = join(dir, 'review.json')
  try {
    await expect(readReview(dir)).rejects.toThrow('缺少 out/review.json')
    await writeFile(path, JSON.stringify(review))
    expect(await readReview(dir)).toEqual(review)
    await writeFile(path, '{')
    await expect(readReview(dir)).rejects.toThrow('out/review.json 不是有效的 JSON')
    for (const invalid of [
      { ...review, verdict: 'approved' },
      { ...review, findings: Array.from({ length: 31 }, () => finding) },
      { ...review, findings: [{ ...finding, line: 0 }] },
    ]) {
      await writeFile(path, JSON.stringify(invalid))
      await expect(readReview(dir)).rejects.toThrow('out/review.json 的结构无效')
    }
    await writeFile(path, ' '.repeat(1024 * 1024 + 1))
    await expect(readReview(dir)).rejects.toThrow('out/review.json 超出大小限制')
    await rm(path)
    await writeFile(join(dir, 'valid.json'), JSON.stringify(review))
    await symlink('valid.json', path)
    await expect(readReview(dir)).rejects.toMatchObject({ code: 'ELOOP' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readPlan 保留子 Issue 顺序并分别报告缺失、无效 JSON、错误结构和大小超限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-plan-'))
  const path = join(dir, 'plan.json')
  const plan: Plan = {
    summary: '先添加标签，再支持筛选。',
    docs: [],
    children: [
      { title: '标签', body: '添加标签。' },
      { title: '筛选', body: '按标签筛选。' },
    ],
  }
  try {
    await expect(readPlan(dir)).rejects.toThrow('缺少 out/plan.json')
    await writeFile(path, JSON.stringify(plan))
    expect(await readPlan(dir)).toEqual(plan)
    for (const [raw, error] of [
      ['{', 'out/plan.json 不是有效的 JSON'],
      [JSON.stringify({ ...plan, children: [] }), 'out/plan.json 的结构无效'],
      [' '.repeat(1024 * 1024 + 1), 'out/plan.json 超出大小限制'],
    ] as const) {
      await writeFile(path, raw)
      await expect(readPlan(dir)).rejects.toThrow(error)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readExecution 读出合法的执行方与评估，逐项忽略不合法的字段且不影响 outcome', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-execution-'))
  try {
    const none = { executor: null, assessment: null }
    expect(await readExecution(dir)).toEqual(none)
    const write = (value: unknown) => writeFile(join(dir, 'outcome.json'), JSON.stringify(value))
    const assessment = { difficulty: 'low', clarity: 'clear', reason: '只改一个函数' } as const
    await write({ outcome: 'completed', executor: 'pi', assessment: { ...assessment, extra: 1 } })
    expect(await readExecution(dir)).toEqual({ executor: 'pi', assessment })
    expect(await readPiOutcome(dir)).toBe('completed')
    await write({ outcome: 'partial', executor: 'human', assessment })
    expect(await readExecution(dir)).toEqual({ executor: null, assessment })
    await write({
      outcome: 'partial',
      executor: 'mixed',
      assessment: { ...assessment, reason: '长'.repeat(501) },
    })
    expect(await readExecution(dir)).toEqual({ executor: 'mixed', assessment: null })
    expect(await readPiOutcome(dir)).toBe('partial')
    await write({ outcome: 'completed' })
    expect(await readExecution(dir)).toEqual(none)
    await writeFile(join(dir, 'outcome.json'), '{')
    expect(await readExecution(dir)).toEqual(none)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
