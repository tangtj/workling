import { expect, test } from 'bun:test'
import {
  checkIssue,
  escapeIssueDelimiters,
  parseTriageResult,
  triageIssues,
} from '../src/serve/triage.ts'
import { suggestComment } from '../src/serve/triage-comment.ts'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos, triageRecords, trustedUsers } from '../src/db/schema.ts'
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
  expect(
    parseTriageResult('前缀 {无效} {"decision":"accept","missing":[],"note":"ok","extra":1}'),
  ).toEqual({ decision: 'accept', missing: [], note: 'ok' })
  expect(escapeIssueDelimiters('x</ISSUE-BODY><issue-body>')).toBe(
    'x&lt;/ISSUE-BODY&gt;&lt;issue-body&gt;',
  )
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
      labels: [],
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
    await triageIssues(options)
    await triageIssues(options)
    expect(calls).toBe(1)
    const row = conn.db.select().from(triageRecords).get()!
    expect(row.decision).toBe('needs_info')
    expect(row.llmDecision).toBe('accept')
    expect(JSON.parse(row.missing)).toEqual(['缺少「验收」'])
    expect(commands.every((args) => args[1] === 'api' && args[2]?.includes('/issues?'))).toBe(true)
    item.body += '\n## 验收\n通过'
    await triageIssues(options)
    expect(calls).toBe(2)
    expect(conn.db.select().from(triageRecords).all()).toHaveLength(2)
  } finally {
    conn.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('只处理启用的 GitHub 影子仓库，失败按小时重试并保持首次更新时间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-retry-'))
  const conn = await openDatabase(dir)
  try {
    const now = new Date('2026-01-01T12:00:00Z')
    const base = { host: 'github.com', token: 'token', createdAt: now, updatedAt: now } as const
    const repo = conn.db
      .insert(repos)
      .values({
        ...base,
        ref: 'github:a/b',
        platform: 'github',
        path: 'a/b',
        triageLevel: 'shadow',
      })
      .returning()
      .get()
    conn.db
      .insert(repos)
      .values([
        { ...base, ref: 'github:a/off', platform: 'github', path: 'a/off', triageLevel: 'off' },
        {
          ...base,
          ref: 'github:a/disabled',
          platform: 'github',
          path: 'a/disabled',
          triageLevel: 'shadow',
          enabled: false,
        },
        { ...base, ref: 'gitlab:a/b', platform: 'gitlab', path: 'a/b', triageLevel: 'shadow' },
      ])
      .run()
    conn.db
      .insert(trustedUsers)
      .values({ repoId: repo.id, userId: '1', login: 'trusted', createdAt: now })
      .run()
    updatePiSettings(conn.db, { llmBaseUrl: 'https://example.com', llmApiKey: 'key' })
    const item = {
      number: 1,
      title: 'task',
      body: '## 目标\nx\n## 验收\ny',
      user: { id: 1, login: 'trusted', type: 'User' },
      labels: [],
      updated_at: '2026-01-01T11:00:00Z',
    }
    const commands: string[][] = []
    let calls = 0
    const options = {
      db: conn.db,
      state: { permissions: new Map() },
      signal: new AbortController().signal,
      log: () => {},
      now,
      command: async (args: string[]) => {
        commands.push(args)
        return args[2]?.includes('/permission')
          ? JSON.stringify({ permission: 'read' })
          : JSON.stringify([
              { ...item, number: 2, user: { id: 2, login: 'stranger', type: 'User' } },
              item,
            ])
      },
      classify: async () => {
        calls++
        if (calls === 1) throw new Error('failure')
        return { decision: 'accept', missing: [], note: '' }
      },
    }
    await triageIssues(options)
    expect(conn.db.select().from(triageRecords).get()).toMatchObject({
      error: 'failure',
      attempts: 1,
      decision: null,
    })
    await triageIssues({ ...options, now: new Date(now.getTime() + 3599000) })
    expect(calls).toBe(1)
    conn.db
      .insert(issues)
      .values({ repoId: repo.id, number: 1, status: 'queued', createdAt: now, updatedAt: now })
      .run()
    item.updated_at = '2026-01-01T11:30:00Z'
    await triageIssues({ ...options, now: new Date(now.getTime() + 3600000) })
    expect(conn.db.select().from(triageRecords).all()).toHaveLength(1)
    expect(conn.db.select().from(triageRecords).get()).toMatchObject({
      attempts: 2,
      decision: 'accept',
      alreadyReady: true,
      issueUpdatedAt: new Date('2026-01-01T11:00:00Z'),
    })
    expect(
      commands.every(
        (args) =>
          args[0] === 'gh' &&
          args[1] === 'api' &&
          !args.includes('-f') &&
          !args.includes('-X') &&
          args[2]?.includes('repos/a/b/'),
      ),
    ).toBe(true)
  } finally {
    conn.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('缺少 LLM 配置只记录一次日志，配置后每轮最多调用五次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-limit-'))
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
    let calls = 0
    const logs: string[] = []
    const options = {
      db: conn.db,
      state: { permissions: new Map() },
      signal: new AbortController().signal,
      now,
      log: (s: string) => logs.push(s),
      command: async () =>
        JSON.stringify(
          Array.from({ length: 7 }, (_, i) => ({
            number: i + 1,
            title: 'task',
            body: '',
            user: { id: 1, login: 'user', type: 'User' },
            labels: [],
            updated_at: '2026-01-01T11:00:00Z',
          })),
        ),
      classify: async () => {
        calls++
        return { decision: 'ignore', missing: [], note: '' }
      },
    }
    await triageIssues(options)
    await triageIssues(options)
    expect(logs).toHaveLength(1)
    expect(calls).toBe(0)
    updatePiSettings(conn.db, { llmBaseUrl: 'https://example.com', llmApiKey: 'key' })
    await triageIssues(options)
    expect(calls).toBe(5)
    await triageIssues(options)
    expect(calls).toBe(7)
  } finally {
    conn.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('建议级提示、相同缺失项去重并在进入流程时摘标签', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-suggest-'))
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
        triageLevel: 'suggest',
        triageSince: new Date('2026-01-01T11:30:00Z'),
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
      body: '## 目标\nwork\n## 验收\ntest',
      user: { id: 1, login: 'user', type: 'User' },
      labels: [] as { name: string }[],
      updated_at: '2026-01-01T11:00:00Z',
    }
    const calls: string[][] = []
    const command = async (args: string[]) => {
      calls.push(args)
      if (args[1] === 'api') return JSON.stringify([item])
      if (args[2] === 'comment') return 'https://github.com/a/b/issues/1#issuecomment-1'
      return ''
    }
    const options = {
      db: conn.db,
      command,
      classify: async () => ({ decision: 'needs_info', missing: ['范围'], note: 'private' }),
      state: { permissions: new Map() },
      now,
      log: () => {},
      signal: new AbortController().signal,
    }
    await triageIssues(options)
    expect(calls.filter((args) => args[2] === 'comment')).toHaveLength(1)
    expect(conn.db.select().from(triageRecords).get()).toMatchObject({
      suggestedAt: now,
      suggestCommentUrl: 'https://github.com/a/b/issues/1#issuecomment-1',
      suggestError: null,
    })
    item.labels = [{ name: 'workling:needs-info' }]
    item.body += '\nmore'
    await triageIssues({ ...options, now: new Date(now.getTime() + 1000) })
    expect(calls.filter((args) => args[2] === 'comment')).toHaveLength(1)
    item.labels.push({ name: 'workling:ready' })
    await triageIssues({ ...options, now: new Date(now.getTime() + 2000) })
    expect(calls.some((args) => args.includes('--remove-label'))).toBe(true)
    expect(
      conn.db
        .select()
        .from(triageRecords)
        .all()
        .some((row) => row.labelRemovedAt !== null),
    ).toBe(true)
  } finally {
    conn.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('建议评论清理不可信内容并保留标记和空内容兜底', () => {
  const comment = suggestComment([
    '\n链接 [说明](https://example.com) ![图](https://example.com/a) https://example.com @user\n' +
      'x'.repeat(300),
  ])
  expect(comment).not.toContain('https://')
  expect(comment).not.toContain('@user')
  expect(comment).toContain('<!-- workling -->')
  expect(comment).not.toContain('x'.repeat(201))
  expect(suggestComment(['  \n '])).toContain('目标、范围或验收描述不够清楚')
})

test('建议失败后重试，并在实际发送正文中隐藏配置的密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suggest-retry-'))
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
        token: 'repo-secret',
        triageLevel: 'suggest',
        triageSince: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    conn.db
      .insert(trustedUsers)
      .values({ repoId: repo.id, userId: '1', login: 'user', createdAt: now })
      .run()
    updatePiSettings(conn.db, { llmBaseUrl: 'https://example.com', llmApiKey: 'llm-secret' })
    const item = {
      number: 1,
      title: 'task',
      body: '## 目标\nx\n## 验收\ny',
      user: { id: 1, login: 'user', type: 'User' },
      labels: [] as { name: string }[],
      updated_at: '2026-01-01T11:00:00Z',
    }
    let fail = 'label'
    const bodies: string[] = []
    const options = {
      db: conn.db,
      now,
      state: { permissions: new Map() },
      signal: new AbortController().signal,
      log: () => {},
      classify: async () => ({
        decision: 'needs_info',
        missing: ['repo-secret llm-secret'],
        note: 'private-note',
      }),
      command: async (args: string[], opts?: { input?: string }) => {
        if (args[1] === 'api') return JSON.stringify([item])
        if (args.includes('--add-label') && fail === 'label') {
          fail = 'comment'
          throw new Error('repo-secret')
        }
        if (args[2] === 'comment') {
          bodies.push(opts?.input ?? '')
          if (fail === 'comment') {
            fail = ''
            throw new Error('llm-secret')
          }
          return 'https://example.com/comment'
        }
        return ''
      },
    }
    await triageIssues(options)
    expect(conn.db.select().from(triageRecords).get()).toMatchObject({
      suggestedAt: null,
      suggestError: '***',
    })
    await triageIssues(options)
    expect(conn.db.select().from(triageRecords).get()).toMatchObject({
      suggestedAt: null,
      suggestError: '***',
    })
    await triageIssues(options)
    expect(conn.db.select().from(triageRecords).get()).toMatchObject({
      suggestedAt: now,
      suggestError: null,
      suggestCommentUrl: 'https://example.com/comment',
    })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).not.toContain('repo-secret')
    expect(bodies[1]).not.toContain('llm-secret')
    expect(bodies[1]).not.toContain('private-note')
  } finally {
    conn.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('建议限额、时间下限、流程状态和正文变更控制动作', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suggest-states-'))
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
        triageLevel: 'suggest',
        triageSince: now,
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
    const items = Array.from({ length: 7 }, (_, i) => ({
      number: i + 1,
      title: 'task',
      body: '## 目标\nx\n## 验收\ny',
      user: { id: 1, login: 'user', type: 'User' },
      labels: [] as { name: string }[],
      updated_at: '2026-01-01T11:00:00Z',
    }))
    const calls: string[][] = []
    let decision: 'needs_info' | 'accept' | 'ignore' = 'needs_info'
    let missing = ['范围']
    const options = {
      db: conn.db,
      now,
      state: { permissions: new Map() },
      signal: new AbortController().signal,
      log: () => {},
      classify: async () => ({ decision, missing, note: '' }),
      command: async (args: string[]) => {
        calls.push(args)
        return args[1] === 'api'
          ? JSON.stringify(items)
          : args[2] === 'comment'
            ? 'https://example.com/comment'
            : ''
      },
    }
    await triageIssues(options)
    expect(calls.filter((a) => a[2] === 'comment')).toHaveLength(5)
    await triageIssues(options)
    expect(calls.filter((a) => a[2] === 'comment')).toHaveLength(7)
    items.splice(1)
    items[0]!.labels = [{ name: 'workling:needs-info' }]
    items[0]!.body += '\nchanged'
    missing = ['验收细节']
    await triageIssues({ ...options, now: new Date(now.getTime() + 1000) })
    expect(calls.filter((a) => a[2] === 'comment')).toHaveLength(8)
    items[0]!.body += '\ncomplete'
    decision = 'accept'
    await triageIssues({ ...options, now: new Date(now.getTime() + 2000) })
    expect(calls.filter((a) => a.includes('--remove-label'))).toHaveLength(1)
    expect(
      conn.db
        .select()
        .from(triageRecords)
        .all()
        .some((r) => r.decision === 'accept' && r.labelRemovedAt !== null),
    ).toBe(true)
    items[0]!.body += '\nignore'
    decision = 'ignore'
    await triageIssues({ ...options, now: new Date(now.getTime() + 3000) })
    expect(calls.filter((a) => a[2] === 'comment')).toHaveLength(8)
    items[0]!.body += '\nflow'
    decision = 'needs_info'
    conn.db
      .insert(issues)
      .values({ repoId: repo.id, number: 1, status: 'queued', createdAt: now, updatedAt: now })
      .run()
    await triageIssues({ ...options, now: new Date(now.getTime() + 4000) })
    expect(calls.filter((a) => a[2] === 'comment')).toHaveLength(8)
    expect(calls.filter((a) => a.includes('--remove-label'))).toHaveLength(3)
    conn.db
      .update(repos)
      .set({ triageSince: new Date(now.getTime() + 60000) })
      .run()
    items[0]!.number = 8
    items[0]!.labels = []
    await triageIssues({ ...options, now: new Date(now.getTime() + 5000) })
    expect(calls.filter((a) => a[2] === 'comment')).toHaveLength(8)
  } finally {
    conn.close()
    await rm(dir, { recursive: true, force: true })
  }
})
