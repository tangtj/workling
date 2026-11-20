import { expect, test } from 'bun:test'
import { classifyCommand } from '../src/serve/feedback.ts'
import { observeFeedback } from '../src/serve/feedback.ts'
import { openDatabase } from '../src/db/index.ts'
import { feedback, feedbackCursors, issues, repos } from '../src/db/schema.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('只把可信作者开头的前缀或请求修改 review 视为指令', () => {
  expect(classifyCommand(' /workling fix', 'write', 'worker', null)).toEqual({
    isCommand: true,
    instruction: 'fix',
  })
  expect(classifyCommand('@Worker fix', 'allowlist', 'worker', null)).toEqual({
    isCommand: true,
    instruction: 'fix',
  })
  expect(classifyCommand('/worklingmore', 'write', 'worker', null).isCommand).toBe(false)
  expect(classifyCommand('hello /workling fix', 'write', 'worker', null).isCommand).toBe(false)
  expect(classifyCommand('/workling fix', 'untrusted', 'worker', null).isCommand).toBe(false)
  expect(classifyCommand('fix', 'write', 'worker', 'CHANGES_REQUESTED')).toEqual({
    isCommand: true,
    instruction: 'fix',
  })
})

test('首次建立游标，之后去重、重新判定编辑并缓存写权限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'observe-feedback-'))
  const { db, close } = await openDatabase(dir)
  try {
    const now = new Date()
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'token',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    db.insert(issues)
      .values({ repoId: repo.id, number: 1, status: 'done', createdAt: now, updatedAt: now })
      .run()
    const state = { accounts: new Map(), permissions: new Map() }
    const calls: string[] = []
    let body = 'hello'
    let updated = '2026-01-02T00:00:00Z'
    const command = async (args: string[]) => {
      const endpoint = args[2] ?? ''
      calls.push(endpoint)
      if (endpoint === 'user') return 'worker'
      if (endpoint.includes('/permission')) return JSON.stringify({ permission: 'write' })
      if (endpoint.includes('issues/comments'))
        return JSON.stringify([
          [
            {
              id: 1,
              user: { id: 5, login: 'alice', type: 'User' },
              body,
              html_url: 'https://example.com/1',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: updated,
              issue_url: 'https://api.github.com/repos/a/b/issues/1',
            },
          ],
        ])
      return '[[]]'
    }
    const options = {
      db,
      command,
      log: (message: string) => {
        throw new Error(message)
      },
      signal: new AbortController().signal,
      state,
    }
    await observeFeedback(options)
    expect(calls).toEqual([])
    db.update(feedbackCursors)
      .set({
        cursor: new Date('2025-12-31T00:00:00Z'),
        startedAt: new Date('2025-12-31T00:00:00Z'),
      })
      .run()
    await observeFeedback(options)
    expect(
      db
        .select()
        .from(feedback)
        .all()
        .map((row) => [row.trust, row.status]),
    ).toEqual([['write', 'ignored']])
    body = '/workling fix'
    updated = '2026-01-03T00:00:00Z'
    await observeFeedback(options)
    await observeFeedback(options)
    expect(
      db
        .select()
        .from(feedback)
        .all()
        .map((row) => [row.status, row.instruction]),
    ).toEqual([['observed', 'fix']])
    expect(calls.filter((call) => call.includes('/permission'))).toHaveLength(1)
    expect(calls.some((call) => call.includes('since=2025-12-30T23:55:00.000Z'))).toBe(true)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})
