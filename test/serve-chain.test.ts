import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { issues, runs } from '../src/db/schema.ts'
import { chainGate } from '../src/serve/launch.ts'
import { pollOnce } from '../src/serve/poll.ts'
import { scenario, clock } from './helpers/serve.ts'
import type { Command } from '../src/runtime/types.ts'

test('串行门控根据前序状态放行、堆叠或等待，并处理跨仓库与读取失败', async () => {
  const s = await scenario()
  try {
    const current = await s.issue(2, 'queued')
    const previous = await s.issue(1, 'running')
    let state = 'open'
    let reason: string | null = null
    let sameRepo = true
    let fail = false
    const command: Command = async (args) => {
      if (fail) throw new Error('offline')
      if (args[2]?.endsWith('/parent')) return '{"number":10}'
      if (args[2]?.includes('/sub_issues?'))
        return JSON.stringify([
          {
            number: 1,
            title: 'one',
            state,
            state_reason: reason,
            repository_url: `https://api.github.com/repos/${sameRepo ? 'a/b' : 'x/y'}`,
          },
          {
            number: 2,
            title: 'two',
            state: 'open',
            state_reason: null,
            repository_url: 'https://api.github.com/repos/a/b',
          },
        ])
      return '{"title":"parent"}'
    }
    const gate = () => chainGate(s.db, s.repo, current, command, s.signal)
    expect((await gate()).kind).toBe('wait')
    s.db.update(issues).set({ status: 'failed' }).where(eq(issues.id, previous.id)).run()
    expect((await gate()).kind).toBe('wait')
    const run = s.db
      .insert(runs)
      .values({
        issueId: previous.id,
        worker: 'w',
        startedAt: clock,
        branch: 'workling/1-one',
        reportResult: '部分完成',
      })
      .returning()
      .get()
    s.db
      .update(issues)
      .set({ status: 'done', prState: 'open', lastRunId: run.id })
      .where(eq(issues.id, previous.id))
      .run()
    expect((await gate()).kind).toBe('wait')
    s.db.update(runs).set({ reportResult: '完成' }).where(eq(runs.id, run.id)).run()
    expect(await gate()).toMatchObject({ kind: 'stack', branch: 'workling/1-one', previous: 1 })
    s.db.update(issues).set({ prState: 'merged' }).where(eq(issues.id, previous.id)).run()
    expect((await gate()).kind).toBe('base')
    s.db.update(issues).set({ prState: null }).where(eq(issues.id, previous.id)).run()
    state = 'closed'
    reason = 'completed'
    expect((await gate()).kind).toBe('base')
    sameRepo = false
    expect((await gate()).kind).toBe('error')
    fail = true
    expect((await gate()).kind).toBe('wait')
  } finally {
    await s.dispose()
  }
})

test('主 Issue 展开可执行子项并跳过已完成项目', async () => {
  const s = await scenario()
  try {
    await s.issue(2, 'done')
    const edits: string[][] = []
    const command: Command = async (args) => {
      if (args[1] === 'label') return ''
      if (args[2] === 'list') return JSON.stringify([{ number: 10, title: 'parent', url: 'url' }])
      if (args[1] === 'api')
        return JSON.stringify(
          [1, 2, 3].map((number) => ({
            number,
            title: 'child',
            state: number === 3 ? 'closed' : 'open',
            state_reason: null,
            repository_url: 'https://api.github.com/repos/a/b',
          })),
        )
      if (args[2] === 'edit') edits.push(args)
      return ''
    }
    await pollOnce({ ...s.options, command })
    expect(
      s.db
        .select()
        .from(issues)
        .all()
        .map((row) => row.number),
    ).toEqual([2])
    expect(edits.map((args) => args[3])).toEqual(['1', '10'])
    expect(edits[0]).toContain('workling:ready')
    expect(edits[1]).toContain('workling:running')
    expect(edits[1]).toContain('workling:ready')
  } finally {
    await s.dispose()
  }
})
