import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOutResult, writeOutResult, type OutResult } from '../src/contract/out.ts'

test('out/result.json 原子写入，并分别报告缺文件、无效 JSON、错误结构和错误版本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-out-'))
  try {
    await expect(readOutResult(dir)).rejects.toThrow('缺少 out/result.json')
    const result: OutResult = {
      contract: 1,
      outcome: 'completed',
      branch: 'workling/42-task',
      head: null,
      commits: 0,
    }
    await writeOutResult(dir, result)
    expect(await readOutResult(dir)).toEqual(result)
    expect(await readdir(dir)).toEqual(['result.json'])
    for (const [data, error] of [
      ['{', '不是有效的 JSON'],
      [JSON.stringify({ ...result, commits: -1 }), '结构无效'],
      [JSON.stringify({ ...result, contract: 2 }), '契约版本不受支持'],
    ] as const) {
      await writeFile(join(dir, 'result.json'), data)
      await expect(readOutResult(dir)).rejects.toThrow(error)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
