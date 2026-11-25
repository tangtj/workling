import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readOutResult,
  readReview,
  writeOutResult,
  type OutResult,
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
