import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos } from '../src/db/schema.ts'
import type { Command, RunOptions } from '../src/runtime/types.ts'
import { WORKLING_LABELS, pollOnce } from '../src/serve/poll.ts'
test('轮询启用的项目并隔离失败，按编号入队并写入 Issue 标题', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-poll-'))
  const { db, close } = await openDatabase(dir)
  try {
    const now = new Date()
    for (const [name, enabled] of [
      ['fail', true],
      ['bad', true],
      ['ok', true],
      ['empty', true],
      ['off', false],
    ] as const)
      db.insert(repos)
        .values({
          ref: `github:a/${name}`,
          platform: 'github',
          host: `${name}.example`,
          path: `a/${name}`,
          token: `token-${name}`,
          enabled,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    const calls: { args: string[]; options?: RunOptions }[] = []
    const command: Command = async (args, options) => {
      calls.push({ args, options })
      if (args[1] === 'label' || args[2] === 'edit') return ''
      if (args[4] === 'a/fail') throw new Error('出错')
      if (args[4] === 'a/bad') return '[{"number":"bad"}]'
      if (args[4] === 'a/empty') return '[]'
      return JSON.stringify([
        { number: 2, title: 'two', url: 'url2' },
        { number: 1, title: 'one', url: 'url1' },
      ])
    }
    const lines: string[] = []
    const controller = new AbortController()
    await pollOnce({ db, command, signal: controller.signal, log: (line) => lines.push(line) })
    const lists = calls.filter((call) => call.args[2] === 'list')
    expect(lists).toHaveLength(4)
    expect(lists[2]!.args).toEqual([
      'gh',
      'issue',
      'list',
      '-R',
      'a/ok',
      '--label',
      'workling:ready',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,url',
    ])
    expect(lists[2]!.options?.env).toMatchObject({
      GH_TOKEN: 'token-ok',
      GH_HOST: 'ok.example',
      GH_PROMPT_DISABLED: '1',
    })
    expect(lists[0]!.options?.env?.GH_TOKEN).toBe('token-fail')
    expect(db.select().from(issues).orderBy(issues.number).all()).toMatchObject([
      { number: 1, title: 'one', status: 'queued' },
      { number: 2, title: 'two', status: 'queued' },
    ])
    expect(lines).toEqual([
      'github:a/fail 轮询失败：出错',
      'github:a/bad 轮询失败：Issue 列表格式无效',
      'github:a/ok #1 one url1',
      'github:a/ok #1 已入队',
      'github:a/ok #1 已标记 workling:queued',
      'github:a/ok #2 two url2',
      'github:a/ok #2 已入队',
      'github:a/ok #2 已标记 workling:queued',
      'github:a/empty 无 workling:ready Issue',
    ])
    const callCount = calls.length
    controller.abort()
    await pollOnce({ db, command, signal: controller.signal, log: (line) => lines.push(line) })
    expect(calls).toHaveLength(callCount)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('轮询只入队新 Issue 和终态 Issue，保留运行中与未列出状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-queue-'))
  const { db, close } = await openDatabase(dir)
  try {
    const old = new Date('2020-01-01T00:00:00Z')
    const project = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'secret',
        createdAt: old,
        updatedAt: old,
      })
      .returning()
      .get()
    const states = ['done', 'failed', 'canceled', 'queued', 'running', 'done'] as const
    for (const [i, status] of states.entries())
      db.insert(issues)
        .values({ repoId: project.id, number: i + 1, status, createdAt: old, updatedAt: old })
        .run()
    const logs: string[] = []
    const calls: string[][] = []
    const command: Command = async (args) => {
      calls.push(args)
      if (args[2] !== 'list') return ''
      return JSON.stringify(
        [7, 5, 4, 3, 2, 1].map((number) => ({
          number,
          title: `title${number}`,
          url: `url${number}`,
        })),
      )
    }
    await pollOnce({
      db,
      command,
      log: (line) => logs.push(line),
      signal: new AbortController().signal,
    })
    const rows = db.select().from(issues).orderBy(issues.number).all()
    expect(rows.map((r) => r.status)).toEqual([
      'queued',
      'queued',
      'queued',
      'queued',
      'running',
      'done',
      'queued',
    ])
    for (const row of rows.slice(0, 3))
      expect(row.updatedAt.getTime()).toBeGreaterThan(old.getTime())
    for (const row of rows.slice(3, 6)) expect(row.updatedAt).toEqual(old)
    expect(rows.map((row) => row.title)).toEqual([
      'title1',
      'title2',
      'title3',
      'title4',
      'title5',
      null,
      'title7',
    ])
    expect(logs.filter((line) => line.endsWith('重新入队'))).toEqual(
      [1, 2, 3].map((n) => `github:a/b #${n} 重新入队`),
    )
    expect(logs).toContain('github:a/b #7 已入队')
    expect(logs).toContain('github:a/b #5 执行中但仍带 workling:ready，已忽略')
    expect(calls.filter((args) => args[2] === 'edit').map((args) => args[3])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '7',
    ])
    await pollOnce({
      db,
      command,
      log: (line) => logs.push(line),
      signal: new AbortController().signal,
    })
    expect(db.select().from(issues).all()).toHaveLength(7)
    expect(logs.filter((line) => line.endsWith('已入队'))).toHaveLength(1)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test.each(['queued', 'running'] as const)(
  '轮询更新 %s Issue 的已有标题并保留状态与更新时间',
  async (status) => {
    const dir = await mkdtemp(join(tmpdir(), 'workling-title-'))
    const { db, close } = await openDatabase(dir)
    try {
      const old = new Date('2020-01-01T00:00:00Z')
      const project = db
        .insert(repos)
        .values({
          ref: 'github:a/b',
          platform: 'github',
          host: 'github.com',
          path: 'a/b',
          token: 'secret',
          createdAt: old,
          updatedAt: old,
        })
        .returning()
        .get()
      const original = db
        .insert(issues)
        .values({
          repoId: project.id,
          number: 1,
          title: '旧标题',
          status,
          createdAt: old,
          updatedAt: old,
        })
        .returning()
        .get()
      const command: Command = async (args) =>
        args[2] === 'list' ? JSON.stringify([{ number: 1, title: '新标题', url: 'url1' }]) : ''
      const poll = () =>
        pollOnce({ db, command, signal: new AbortController().signal, log: () => {} })
      await poll()
      expect(db.select().from(issues).get()).toEqual({ ...original, title: '新标题' })
      await poll()
      expect(db.select().from(issues).get()).toEqual({ ...original, title: '新标题' })
    } finally {
      close()
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test('标签创建缓存、同步失败重试且不阻塞后续 Issue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-labels-'))
  const { db, close } = await openDatabase(dir)
  try {
    const now = new Date()
    db.insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'git.example',
        path: 'a/b',
        token: 'own-token',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const calls: { args: string[]; options?: RunOptions }[] = []
    const logs: string[] = []
    let failCreate = true
    let failEdit = true
    const command: Command = async (args, options) => {
      calls.push({ args, options })
      if (args[1] === 'label' && failCreate) throw new Error('创建失败')
      if (args[2] === 'edit' && args[3] === '1' && failEdit) throw new Error('编辑失败')
      if (args[2] === 'list')
        return JSON.stringify([1, 2].map((number) => ({ number, title: 't', url: 'u' })))
      return ''
    }
    const labeledRepos = new Set<number>()
    const poll = (cache?: Set<number>) =>
      pollOnce({
        db,
        command,
        signal: new AbortController().signal,
        log: (line) => logs.push(line),
        labeledRepos: cache,
      })
    await poll(labeledRepos)
    expect(logs).toContain('github:a/b 创建标签失败：创建失败')
    expect(
      db
        .select()
        .from(issues)
        .all()
        .map((row) => row.status),
    ).toEqual(['queued', 'queued'])
    expect(calls.filter((call) => call.args[2] === 'edit')).toHaveLength(0)
    failCreate = false
    calls.length = 0
    await poll(labeledRepos)
    expect(calls.filter((call) => call.args[1] === 'label').map((call) => call.args)).toEqual(
      WORKLING_LABELS.map((label) => [
        'gh',
        'label',
        'create',
        label.name,
        '-R',
        'a/b',
        '--color',
        label.color,
        '--description',
        label.description,
        '--force',
      ]),
    )
    const edits = calls.filter((call) => call.args[2] === 'edit')
    expect(edits.map((call) => call.args)).toEqual(
      [1, 2].map((n) => [
        'gh',
        'issue',
        'edit',
        String(n),
        '-R',
        'a/b',
        '--remove-label',
        'workling:ready',
        '--add-label',
        'workling:queued',
      ]),
    )
    expect(edits[0]!.options?.env).toMatchObject({ GH_TOKEN: 'own-token', GH_HOST: 'git.example' })
    expect(logs).toContain('github:a/b #1 更新标签失败：编辑失败')
    expect(logs).toContain('github:a/b #2 已标记 workling:queued')
    expect(
      db
        .select()
        .from(issues)
        .all()
        .map((row) => row.status),
    ).toEqual(['queued', 'queued'])
    failEdit = false
    calls.length = 0
    await poll(labeledRepos)
    expect(calls.filter((call) => call.args[1] === 'label')).toHaveLength(0)
    expect(logs).toContain('github:a/b #1 已标记 workling:queued')
    calls.length = 0
    await poll()
    await poll()
    expect(calls.filter((call) => call.args[1] === 'label')).toHaveLength(10)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})
