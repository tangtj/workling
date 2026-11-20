import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Value from 'typebox/value'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos, runs, sessions } from '../src/db/schema.ts'
import { createApp } from '../src/web/app.ts'
import { hashToken } from '../src/web/auth.ts'
import { buildWebBundle, getWebBundle } from '../src/web/bundle.ts'
import { shellSchema } from '../src/web/shell.ts'
import { issueListSchema } from '../src/web/issue-list.ts'
import { overviewSchema } from '../src/web/overview.ts'
import { eq } from 'drizzle-orm'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'workling-spa-'))
  const { db, close } = await openDatabase(dir)
  const now = new Date()
  db.insert(sessions)
    .values({ id: hashToken('spa'), createdAt: now, expiresAt: new Date(now.getTime() + 60000) })
    .run()
  const repo = db
    .insert(repos)
    .values({
      ref: 'github:owner/repo',
      platform: 'github',
      host: 'github.com',
      path: 'owner/repo',
      token: 'never-return-this-token',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  const records = (['queued', 'running', 'failed', 'done'] as const).map((status, index) =>
    db
      .insert(issues)
      .values({
        repoId: repo.id,
        number: index + 1,
        title: 'SPA fixture',
        status,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get(),
  )
  const issue = records[0]!
  const run = db
    .insert(runs)
    .values({ issueId: issue.id, worker: 'spa-worker', startedAt: now })
    .returning()
    .get()
  const app = createApp(db, {
    workspace: dir,
    now: () => now.getTime(),
    status: () => ({
      worker: 'spa-worker',
      interval: 60,
      timeout: 90,
      startedAt: now,
      lastPollAt: now,
      lastPollError: null,
    }),
  })
  return {
    app,
    db,
    now,
    repo,
    paths: [
      '/',
      '/issues',
      `/issues/${issue.id}`,
      '/repos',
      `/repos/${repo.id}`,
      '/settings',
      `/runs/${run.id}/log`,
    ],
    request: (path: string, fragment = false, authenticated = true) =>
      app.request(path, {
        headers: {
          host: 'localhost',
          ...(authenticated ? { cookie: 'workling_session=spa' } : {}),
          ...(fragment ? { 'X-Workling-Fragment': '1' } : {}),
        },
      }),
    cleanup: async () => {
      close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('七个页面普通请求返回同一外壳，引用带哈希的 JS 与 CSS 且保留主题 CSP', async () => {
  const f = await fixture()
  try {
    let shell: string | undefined
    for (const path of f.paths) {
      const response = await f.request(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('vary')).toContain('X-Workling-Fragment')
      expect(response.headers.get('content-security-policy')).toContain(
        "script-src 'self' 'sha256-",
      )
      const body = await response.text()
      expect(body).toContain('<div id="root"></div>')
      expect(body).toContain('<meta name="color-scheme" content="light dark"')
      expect(body).toMatch(/src="\/assets\/main-[^"/]+\.js"/)
      expect(body).toMatch(/href="\/assets\/main-[^"/]+\.css"/)
      expect(body).not.toContain('SPA fixture')
      if (shell) expect(body).toBe(shell)
      shell = body
    }
  } finally {
    await f.cleanup()
  }
})

test('包括 Issue 详情在内的页面在普通请求与片段请求中返回相同外壳', async () => {
  const f = await fixture()
  try {
    for (const path of f.paths) {
      const response = await f.request(path, true)
      expect(response.status).toBe(200)
      expect(response.headers.has('X-Workling-Title')).toBe(false)
      expect(response.headers.get('vary')).toContain('X-Workling-Fragment')
      const shell = await response.text()
      expect(shell).toContain('id="root"')
      const ordinary = await f.request(path)
      expect(ordinary.status).toBe(200)
      expect(shell).toBe(await ordinary.text())
    }
  } finally {
    await f.cleanup()
  }
})

test('不存在或非法的详情 ID 在外壳与片段模式都返回 404', async () => {
  const f = await fixture()
  try {
    for (const path of [
      '/issues/9999',
      '/repos/9999',
      '/runs/9999/log',
      '/issues/invalid',
      '/repos/0',
      '/runs/-1/log',
    ]) {
      for (const fragment of [true, false]) {
        const response = await f.request(path, fragment)
        expect(response.status).toBe(404)
        expect(await response.text()).toContain('id="root"')
      }
    }
  } finally {
    await f.cleanup()
  }
})

test('侧栏数据通过严格形状校验，统计活动任务并排除凭证，未知 watch 返回 null', async () => {
  const f = await fixture()
  try {
    const response = await f.request('/api/shell')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body: unknown = await response.json()
    expect(Value.Check(shellSchema, body)).toBe(true)
    expect(body).toMatchObject({
      repos: [{ id: f.repo.id, ref: 'github:owner/repo', enabled: true, open: 3 }],
      running: 1,
      failed: 1,
      watch: {
        worker: 'spa-worker',
        interval: 60,
        lastPollAt: f.now.toISOString(),
        lastPollError: null,
      },
      now: f.now.toISOString(),
    })
    expect(JSON.stringify(body)).not.toMatch(/token|never-return/)
    // A separate app shares the same database lifecycle but has no watch provider.
    const dir = await mkdtemp(join(tmpdir(), 'workling-spa-no-watch-'))
    const { db, close } = await openDatabase(dir)
    try {
      db.insert(sessions)
        .values({
          id: hashToken('spa'),
          createdAt: f.now,
          expiresAt: new Date(f.now.getTime() + 60000),
        })
        .run()
      const app = createApp(db, { workspace: dir })
      const response = await app.request('/api/shell', {
        headers: { host: 'localhost', cookie: 'workling_session=spa' },
      })
      expect(await response.json()).toMatchObject({ repos: [], watch: null, failed: 0, running: 0 })
    } finally {
      close()
      await rm(dir, { recursive: true, force: true })
    }
  } finally {
    await f.cleanup()
  }
})

test('未登录页面跳转登录，片段与侧栏返回 401，公共资源仍受 Host 校验', async () => {
  const f = await fixture()
  try {
    for (const path of f.paths) {
      const response = await f.request(path, false, false)
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/login')
      expect((await f.request(path, true, false)).status).toBe(401)
    }
    expect((await f.request('/api/shell', false, false)).status).toBe(401)
    const unknownAsset = await f.request('/assets/nested/unknown.js', false, false)
    expect(unknownAsset.status).toBe(404)
    expect(await unknownAsset.text()).toBe('')
    expect(
      (await f.app.request('/assets/unknown.js', { headers: { host: 'evil.example' } })).status,
    ).toBe(403)
  } finally {
    await f.cleanup()
  }
})

test('内存打包产生 React JS 和 CSS，不混入 Hono JSX，缓存 Promise 只构建一次', async () => {
  const bundle = await buildWebBundle()
  expect(bundle.script).toMatch(/^\/assets\/main-[^/]+\.js$/)
  expect(bundle.styles.length).toBeGreaterThan(0)
  const javascript = new TextDecoder().decode(bundle.files.get(bundle.script)!.body)
  expect(javascript).not.toContain('hono/jsx')
  expect(javascript).not.toContain('hono/jsx/jsx-runtime')
  expect(javascript).toContain('workling-theme')
  expect(getWebBundle()).toBe(getWebBundle())
})

test('带哈希的资源可匿名读取且长期缓存并保留 CSP，未知资源返回 404', async () => {
  const f = await fixture()
  try {
    const bundle = await getWebBundle()
    for (const [path, file] of bundle.files) {
      const response = await f.request(path, false, false)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(response.headers.get('content-type')).toBe(file.type)
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(file.body))
    }
    expect((await f.request('/assets/does-not-exist.js', false, false)).status).toBe(404)
  } finally {
    await f.cleanup()
  }
})

test('任务列表接口校验数据并隐藏 token，匿名返回 401', async () => {
  const f = await fixture()
  try {
    const response = await f.request('/api/issue-list')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body: unknown = await response.json()
    expect(Value.Check(issueListSchema, body)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('never-return-this-token')
    if (!Value.Check(issueListSchema, body)) throw new Error('invalid issue list')
    expect(body.repos[0]?.tokenMask).toBe('****oken')
    expect(body.issues[0]?.runCount).toBe(1)
    expect((await f.request('/api/issue-list', false, false)).status).toBe(401)
  } finally {
    await f.cleanup()
  }
})

test('概览接口仅包含活动任务、近期运行与最后运行，隐藏凭证并要求登录', async () => {
  const f = await fixture()
  try {
    const old = new Date(f.now.getTime() - 86400001)
    const recent = new Date(f.now.getTime() - 1000)
    const insert = (number: number) =>
      f.db
        .insert(issues)
        .values({ repoId: f.repo.id, number, status: 'done', createdAt: old, updatedAt: old })
        .returning()
        .get()
    const excluded = insert(50)
    const included = insert(51)
    const addRun = (issueId: number, endedAt: Date) =>
      f.db
        .insert(runs)
        .values({ issueId, worker: 'worker', startedAt: old, endedAt })
        .returning()
        .get()
    addRun(excluded.id, old)
    const latest = addRun(included.id, old)
    const within = addRun(included.id, recent)
    addRun(included.id, old)
    f.db.update(issues).set({ lastRunId: latest.id }).where(eq(issues.id, included.id)).run()
    const response = await f.request('/api/overview')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body: unknown = await response.json()
    expect(Value.Check(overviewSchema, body)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('never-return-this-token')
    if (!Value.Check(overviewSchema, body)) throw new Error('invalid overview')
    expect(body.issues.map((i) => i.id)).not.toContain(excluded.id)
    expect(
      body.issues
        .find((i) => i.id === included.id)
        ?.runs.map((r) => r.id)
        .sort(),
    ).toEqual([latest.id, within.id].sort())
    expect(body.issues.find((i) => i.id === included.id)?.runCount).toBe(3)
    expect((await f.request('/api/overview', false, false)).status).toBe(401)
  } finally {
    await f.cleanup()
  }
})
