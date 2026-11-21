import { expect, test } from 'bun:test'
import { checkIssue, parseTriageResult, triageShadow } from '../src/serve/triage.ts'
import { openDatabase } from '../src/db/index.ts'
import { repos, triageRecords, trustedUsers } from '../src/db/schema.ts'
import { updatePiSettings } from '../src/config/pi.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('检查必需章节、代码围栏和指令格式', () => {
  expect(checkIssue('## 目标\n实现\n## 验收\n通过\n强度：high\n模型：x')).toEqual({
    missingSections: [],
    invalidDirectives: [],
  })
  const result = checkIssue('```\n## 目标\n内容\n```\n## 验收\n \n分支：../bad\n强度：bad\n模型：')
  expect(result.missingSections).toEqual(['目标'])
  expect(result.invalidDirectives).toHaveLength(3)
  expect(checkIssue('## 目标\n\n## 验收\n').missingSections).toEqual(['目标', '验收'])
})

test('输出校验拒绝非法字段，提取 JSON 并限制长度', () => {
  expect(() => parseTriageResult('not json')).toThrow()
  expect(() => parseTriageResult('{"decision":"yes","missing":[],"note":""}')).toThrow()
  const result = parseTriageResult(
    `前缀 ${JSON.stringify({ decision: 'accept', missing: ['a'.repeat(300)], note: 'b'.repeat(3000) })} 后缀`,
  )
  expect(result.missing[0]?.length).toBe(200)
  expect(result.note.length).toBe(2000)
})

test('影子分诊只读取受信且冷静的 Issue，去重并对规则失败降级', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-'))
  const conn = await openDatabase(dir)
  try {
    const now = new Date('2026-01-01T12:00:00Z')
    const repo = conn.db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'token',
        triageLevel: 'shadow',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    conn.db
      .insert(trustedUsers)
      .values({ repoId: repo.id, userId: '1', login: 'user', createdAt: now })
      .run()
    updatePiSettings(conn.db, { llmBaseUrl: 'https://example.com', llmApiKey: 'key' })
    const item = {
      number: 1,
      title: 'task',
      body: '## 目标\nwork',
      user: { id: 1, login: 'user', type: 'User' },
      updated_at: '2026-01-01T11:00:00Z',
    }
    let calls = 0
    const commands: string[][] = []
    const command = async (args: string[]) => {
      commands.push(args)
      return JSON.stringify([
        item,
        { ...item, number: 2, pull_request: {} },
        { ...item, number: 3, updated_at: now.toISOString() },
      ])
    }
    const classify = async () => {
      calls++
      return { decision: 'accept', missing: ['缺少「验收」'], note: '说明' }
    }
    const state = { permissions: new Map() }
    const options = {
      db: conn.db,
      command,
      classify,
      state,
      now,
      log: () => {},
      signal: new AbortController().signal,
    }
    await triageShadow(options)
    await triageShadow(options)
    expect(calls).toBe(1)
    const row = conn.db.select().from(triageRecords).get()!
    expect(row.decision).toBe('needs_info')
    expect(row.llmDecision).toBe('accept')
    expect(JSON.parse(row.missing)).toEqual(['缺少「验收」'])
    expect(commands.every((args) => args[1] === 'api' && args[2]?.includes('/issues?'))).toBe(true)
    item.body += '\n## 验收\n通过'
    await triageShadow(options)
    expect(calls).toBe(2)
    expect(conn.db.select().from(triageRecords).all()).toHaveLength(2)
  } finally {
    conn.close()
    await rm(dir, { recursive: true, force: true })
  }
})
