import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChecklist, readIssueComment } from '../src/contract/out.ts'
import { applyChecklist, planChecklist } from '../src/issue/checklist.ts'

const line = '- [ ] Check'
const item = { line, checked: true, evidence: 'bun run check' }

test.each([
  ['逐字匹配', line, undefined],
  ['忽略行尾空白', line + ' \t', undefined],
  ['不忽略行首空白', ' ' + line, 'missing'],
  ['区分大小写', '- [ ] check', 'missing'],
  ['反引号围栏', '```md\n' + line + '\n```', 'missing'],
  ['围栏中的引用符不是结束围栏', '```\n> ```\n' + line + '\n```', 'missing'],
  ['波浪号围栏', '~~~~\n~~~\n' + line + '\n~~~~', 'missing'],
  ['缩进代码', '    - [ ] Check', 'missing'],
  ['HTML 注释', '<!--\n' + line + '\n-->', 'missing'],
  ['代码示例与真实待办同名', '<!--\n' + line + '\n-->\n' + line, undefined],
  ['匹配多行', line + '\n' + line + ' ', 'ambiguous'],
  ['没有待办行', 'Check', 'missing'],
] as const)('计划待办变更：%s', (_name, body, reason) => {
  expect(planChecklist(body, [item])).toEqual(
    reason ? { changes: [], skipped: [{ item, reason }] } : { changes: [item], skipped: [] },
  )
})

test('已勾选的待办保持原样，支持取消大写 X 和嵌套待办', () => {
  const checked = { ...item, line: '* [X] Parent' }
  const nested = { ...item, line: '  + [ ] Child [ ]' }
  const body = 'Title\r\n\r\n* [X] Parent  \r\n  + [ ] Child [ ]  \r\n1. [ ] Last'
  expect(planChecklist(body, [checked]).skipped).toEqual([{ item: checked, reason: 'unchanged' }])
  const { changes } = planChecklist(body, [{ ...checked, checked: false }, nested])
  expect(applyChecklist(body, changes)).toBe(
    'Title\r\n\r\n* [ ] Parent  \r\n  + [x] Child [ ]  \r\n1. [ ] Last',
  )
  const latest = '用户刚改的标题\r\n  + [ ] Renamed\r\n* [X] Parent\r\n* [X] Parent'
  expect(applyChecklist(latest, changes)).toBe(latest)
})

test('待办文件可省略，校验个数、原文行、证据和字段类型', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-checklist-'))
  try {
    const path = join(dir, 'checklist.json')
    expect(await readChecklist(dir)).toEqual([])
    await writeFile(path, JSON.stringify([item]))
    expect(await readChecklist(dir)).toEqual([item])
    for (const input of [
      Array(51).fill(item),
      [{ ...item, line: line + '\r\n' }],
      [{ ...item, line: 'a'.repeat(501) }],
      [{ ...item, evidence: 'a'.repeat(1001) }],
      [{ ...item, checked: 'true' }],
      { item },
    ]) {
      await writeFile(path, JSON.stringify(input))
      await expect(readChecklist(dir)).rejects.toThrow('结构无效')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('超长 Issue 说明只读取有界前缀，截断后保留提示', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-issue-comment-'))
  try {
    const path = join(dir, 'issue-comment.md')
    expect(await readIssueComment(dir)).toBe('')
    await writeFile(path, '字'.repeat(60_000))
    expect(await readIssueComment(dir)).toBe('字'.repeat(60_000))
    await writeFile(path, '字'.repeat(100_000))
    const text = await readIssueComment(dir)
    expect(text).toHaveLength(60_000)
    expect(text.endsWith('（已截断）')).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
