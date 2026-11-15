import { readExecutorSettings, updateExecutorSettings } from '../src/config/executor.ts'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { assetUrl, type AssetName } from '../src/web/assets.ts'
import { themeScript } from '../src/web/views/theme.ts'
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/db/index.ts'
import { ensurePassword, hashToken } from '../src/web/auth.ts'
import { issues, repos, runs, sessions } from '../src/db/schema.ts'
import { createApp } from '../src/web/app.ts'
import type { ServeStatus } from '../src/serve/index.ts'
import { pageData } from '../src/web/data.ts'
import { failureReason } from '../src/web/views/shared.tsx'

test('管理接口校验请求、掩码凭证并管理仓库', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-api-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir })
  const password = await ensurePassword(db)
  const login = await app.request('/login', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const request = (
    path: string,
    method = 'GET',
    body?: string,
    extra: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        host: 'localhost:7420',
        cookie,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extra,
      },
      body,
    })
  try {
    expect(await (await request('/health')).json()).toEqual({ ok: true })
    const created = await request(
      '/api/repos',
      'POST',
      JSON.stringify({ ref: 'github:a/b', token: ' longsecret1234 ' }),
    )
    expect(created.status).toBe(201)
    const project = await created.json()
    expect(project.token).toBe('****1234')
    expect(project.enabled).toBe(true)
    expect(new Date(project.createdAt).toISOString()).toBe(project.createdAt)
    const list = await (await request('/api/repos')).text()
    expect(list).not.toContain('longsecret1234')
    expect(list).toContain('****1234')
    expect(
      (
        await request(
          '/api/repos',
          'POST',
          JSON.stringify({ ref: 'https://github.com/a/b.git', token: 'x' }),
        )
      ).status,
    ).toBe(409)
    expect(
      (await request('/api/repos', 'POST', JSON.stringify({ ref: 'bad', token: 'x' }))).status,
    ).toBe(400)
    expect(
      await (
        await request('/api/repos', 'POST', JSON.stringify({ ref: 'github:a/b', token: 'x' }))
      ).json(),
    ).toEqual({ error: '仓库已存在' })
    expect(
      await (
        await request('/api/repos', 'POST', JSON.stringify({ ref: 'bad', token: 'x' }))
      ).json(),
    ).toEqual({ error: '仓库引用无效' })
    expect(await (await request('/api/repos', 'POST', '{}')).json()).toEqual({
      error: '仓库参数无效',
    })
    expect(await (await request('/api/repos/999', 'DELETE')).json()).toEqual({
      error: '仓库不存在',
    })
    const gitlab = await request(
      '/api/repos',
      'POST',
      JSON.stringify({ ref: 'gitlab:a/b', token: 'x' }),
    )
    expect(gitlab.status).toBe(400)
    expect(await gitlab.json()).toEqual({ error: '暂只支持 GitHub 仓库' })
    for (const body of [
      { ref: 'github:c/d' },
      { ref: 'github:c/d', token: '  ' },
      { ref: 'github:c/d', token: 'x', extra: 1 },
    ])
      expect((await request('/api/repos', 'POST', JSON.stringify(body))).status).toBe(400)
    expect(
      (await request('/api/repos', 'POST', '{}', { 'content-type': 'text/plain' })).status,
    ).toBe(415)
    expect((await request('/api/repos', 'POST', '{')).status).toBe(400)
    expect((await request('/health', 'GET', undefined, { host: 'evil.com' })).status).toBe(403)
    expect((await request('/health', 'GET', undefined, { host: '[::1]:7420' })).status).toBe(200)
    const patched = await request(
      `/api/repos/${project.id}`,
      'PATCH',
      JSON.stringify({ token: 'newsecret5678', enabled: false }),
    )
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ token: '****5678', enabled: false })
    expect(db.query.repos.findFirst().sync()?.token).toBe('newsecret5678')
    expect((await request(`/api/repos/${project.id}`, 'PATCH', '{}')).status).toBe(400)
    expect(
      (await request(`/api/repos/${project.id}`, 'PATCH', JSON.stringify({ token: '  ' }))).status,
    ).toBe(400)
    expect(
      (
        await request(
          `/api/repos/${project.id}`,
          'PATCH',
          JSON.stringify({ enabled: true, extra: 1 }),
        )
      ).status,
    ).toBe(400)
    expect(
      (await request(`/api/repos/${project.id}`, 'PATCH', '{}', { 'content-type': 'text/plain' }))
        .status,
    ).toBe(415)
    expect((await request(`/api/repos/${project.id}`, 'PATCH', '{')).status).toBe(400)
    expect((await request('/api/repos/0', 'PATCH', '{}')).status).toBe(404)
    expect((await request('/api/repos/999', 'PATCH', '{}')).status).toBe(404)
    expect((await request('/api/repos/999', 'DELETE')).status).toBe(404)
    expect((await request(`/api/repos/${project.id}`, 'DELETE')).status).toBe(204)
    expect(await (await request('/api/repos')).json()).toEqual([])
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('管理页面资源受 Host 校验并设置安全响应头', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-web-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir })
  try {
    const password = await ensurePassword(db)
    const login = await app.request('/login', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const headers = {
      host: 'localhost:7420',
      cookie: login.headers.get('set-cookie')!.split(';')[0]!,
    }
    const response = await app.request('/', { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toMatch(
      /^default-src 'none'; script-src 'self' 'sha256-[A-Za-z0-9+/=]+'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/,
    )
    const html = await response.text()
    expect(html).toContain('<meta name="color-scheme" content="light dark"/>')
    expect(response.headers.get('content-security-policy')).toContain(
      `'sha256-${createHash('sha256').update(themeScript).digest('base64')}'`,
    )
    for (const name of ['style.css', 'app.js', 'version.js'] as const) {
      expect(html).toContain(assetUrl(name))
    }
    for (const name of [
      'style.css',
      'app.js',
      'version.js',
      'timeline.js',
      'run-log.js',
      'login.js',
    ] as AssetName[]) {
      const url = assetUrl(name)
      expect(url).toMatch(/\?v=[0-9a-f]{12}$/)
      const asset = await app.request(url, { headers })
      const body = await asset.text()
      expect(url).toEndWith(createHash('sha256').update(body).digest('hex').slice(0, 12))
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(asset.headers.get('content-security-policy')).toBe(
        response.headers.get('content-security-policy'),
      )
      expect(
        (await app.request(`/${name}?v=wrong`, { headers })).headers.get('cache-control'),
      ).toBe('no-cache')
      if (name === 'run-log.js') expect(body).toContain(`from '${assetUrl('timeline.js')}'`)
    }
    expect(html).toContain('<script src="/app.js?v=')
    expect(html).toContain('<script src="/version.js?v=')
    expect(html).toContain('id="version-pill"')
    expect(html).toContain('id="version-popover"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="版本与更新"')
    expect(html).toContain('rel="noopener noreferrer"')
    for (const path of ['/issues', '/repos', '/settings']) {
      const page = await (await app.request(path, { headers })).text()
      expect(page).toContain('id="version-pill"')
      expect(page).toContain('id="version-popover"')
      expect(page).toContain('<script src="/version.js?v=')
    }
    expect(html).toContain('/style.css')
    expect(html.match(/<script>(.*?)<\/script>/g)).toHaveLength(1)
    expect(html).not.toMatch(/\sstyle\s*=/i)
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i)
    for (const [path, type] of [
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/version.js', 'text/javascript; charset=utf-8'],
      ['/style.css', 'text/css; charset=utf-8'],
      ['/login.js', 'text/javascript; charset=utf-8'],
    ]) {
      const asset = await app.request(path, { headers })
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toBe(type)
      expect(asset.headers.get('content-security-policy')).toBe(
        response.headers.get('content-security-policy'),
      )
      expect(asset.headers.get('x-content-type-options')).toBe('nosniff')
      expect(asset.headers.get('referrer-policy')).toBe('no-referrer')
      expect(asset.headers.get('cache-control')).toBe('no-cache')
    }
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await app.request('/', { headers: { host: 'evil.com' } })).status).toBe(403)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Host 白名单允许配置域名及端口并拒绝其他主机', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-host-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir, allowedHosts: ['workling.example.com'] })
  try {
    expect(
      (await app.request('/health', { headers: { host: 'workling.example.com:8080' } })).status,
    ).toBe(200)
    expect((await app.request('/health', { headers: { host: 'evil.com' } })).status).toBe(403)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('登录鉴权、会话过期、限流窗口和退出登录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-auth-api-'))
  const { db, close } = await openDatabase(dir)
  let time = Date.now()
  const app = createApp(db, { workspace: dir, now: () => time })
  let cookie = ''
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        host: 'localhost',
        cookie,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  try {
    const password = await ensurePassword(db)
    for (const path of ['/api/repos', '/api/status', '/api/missing']) {
      const response = await request(path)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: '未登录' })
    }
    for (const path of ['/', '/repos/1', '/issues/1', '/app.js']) {
      const redirect = await request(path)
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get('location')).toBe('/login')
    }
    for (const path of ['/api/repos', '/repos/1']) {
      const response = await request(path, 'POST', {})
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: '未登录' })
    }
    for (const path of ['/health', '/login', '/style.css', '/login.js'])
      expect((await request(path)).status).toBe(200)
    const page = await request('/login')
    expect(page.headers.get('cache-control')).toBe('no-store')
    const html = await page.text()
    expect(html).toContain('<meta name="color-scheme" content="light dark"/>')
    expect(html).toContain(assetUrl('style.css'))
    expect(html).toContain(assetUrl('login.js'))
    expect((await request(assetUrl('style.css'))).status).toBe(200)
    expect((await request(assetUrl('login.js'))).status).toBe(200)
    expect((await request(assetUrl('app.js'))).status).toBe(302)
    expect(html.match(/<script>(.*?)<\/script>/g)).toHaveLength(1)
    expect(html).not.toMatch(/\sstyle\s*=/i)
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i)
    expect((await request('/login', 'POST', { password, extra: true })).status).toBe(400)
    expect((await request('/login', 'POST', { password: 123 })).status).toBe(400)
    expect((await request('/logout', 'POST')).status).toBe(415)
    expect((await request('/logout', 'POST', {})).status).toBe(204)
    for (let i = 0; i < 5; i++) {
      const failed = await request('/login', 'POST', { password: 'wrong' })
      expect(failed.status).toBe(401)
      expect(await failed.json()).toEqual({ error: '密码不正确' })
    }
    const blocked = await request('/login', 'POST', { password })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: '尝试次数过多，请稍后再试' })
    time += 15 * 60 * 1000
    const loggedIn = await request('/login', 'POST', { password })
    expect(loggedIn.status).toBe(204)
    const setCookie = loggedIn.headers.get('set-cookie')!
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=604800'])
      expect(setCookie).toContain(flag)
    expect(setCookie).not.toContain('Secure')
    cookie = setCookie.split(';')[0]!
    const token = cookie.slice('workling_session='.length)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(db.select().from(sessions).get()?.id).toBe(hashToken(token))
    expect((await request('/api/repos')).status).toBe(200)
    const loggedRedirect = await request('/login')
    expect(loggedRedirect.status).toBe(302)
    expect(loggedRedirect.headers.get('location')).toBe('/')
    time += 7 * 24 * 60 * 60 * 1000
    expect((await request('/api/repos')).status).toBe(401)
    expect(db.select().from(sessions).all()).toHaveLength(0)
    cookie = ''
    // 登录成功后失败次数清零。
    for (let i = 0; i < 4; i++)
      expect((await request('/login', 'POST', { password: 'wrong' })).status).toBe(401)
    const again = await request('/login', 'POST', { password })
    expect(again.status).toBe(204)
    cookie = again.headers.get('set-cookie')!.split(';')[0]!
    for (let i = 0; i < 4; i++)
      expect((await request('/login', 'POST', { password: 'wrong' })).status).toBe(401)
    expect((await request('/login', 'POST', { password })).status).toBe(204)
    const logout = await request('/logout', 'POST', {})
    expect(logout.status).toBe(204)
    expect(logout.headers.get('set-cookie')).toBe(
      'workling_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    )
    expect((await request('/api/repos')).status).toBe(401)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
}, 15000)

test('secureCookie 为 true 时登录和登出 Cookie 均设置 Secure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-secure-cookie-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir, secureCookie: true })
  try {
    const password = await ensurePassword(db)
    const login = await app.request('/login', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    expect(login.headers.get('set-cookie')).toContain('; Secure')
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const logout = await app.request('/logout', {
      method: 'POST',
      headers: { host: 'localhost', cookie, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(logout.headers.get('set-cookie')).toContain('; Secure')
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Issue 接口要求登录并返回按时间排序的状态和执行历史', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-issues-api-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir })
  try {
    expect((await app.request('/api/issues', { headers: { host: 'localhost' } })).status).toBe(401)
    expect(
      (await app.request('/api/issues/1/runs', { headers: { host: 'localhost' } })).status,
    ).toBe(401)
    const password = await ensurePassword(db)
    const login = await app.request('/login', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const headers = { host: 'localhost', cookie: login.headers.get('set-cookie')!.split(';')[0]! }
    const request = (path: string) => app.request(path, { headers })
    const old = new Date('2020-01-01T00:00:00Z')
    const recent = new Date('2020-01-02T00:00:00Z')
    const project = db
      .insert(repos)
      .values({
        ref: 'github:git.example/a/b',
        platform: 'github',
        host: 'git.example',
        path: 'a/b',
        token: 'never-return',
        createdAt: old,
        updatedAt: old,
      })
      .returning()
      .get()
    const queued = db
      .insert(issues)
      .values({
        repoId: project.id,
        number: 1,
        status: 'queued',
        createdAt: old,
        updatedAt: old,
      })
      .returning()
      .get()
    const done = db
      .insert(issues)
      .values({
        repoId: project.id,
        number: 2,
        title: '已完成的 Issue',
        status: 'done',
        prUrl: 'https://git.example/a/b/pull/3',
        prState: 'merged',
        createdAt: old,
        updatedAt: recent,
      })
      .returning()
      .get()
    const first = db
      .insert(runs)
      .values({
        issueId: done.id,
        worker: 'worker1',
        taskDir: '/tasks/first',
        startedAt: old,
        endedAt: old,
        exitCode: 1,
        error: 'failed',
      })
      .returning()
      .get()
    const last = db
      .insert(runs)
      .values({ issueId: done.id, worker: 'worker2', startedAt: recent })
      .returning()
      .get()
    db.update(issues).set({ lastRunId: last.id }).where(eq(issues.id, done.id)).run()
    const lastResponse = {
      id: last.id,
      worker: 'worker2',
      startedAt: recent.toISOString(),
      endedAt: null,
      exitCode: null,
      error: null,
      summary: null,
      reportResult: null,
      logTail: null,
    }
    expect(await (await request('/api/issues')).json()).toEqual([
      {
        id: done.id,
        repoId: project.id,
        ref: project.ref,
        number: 2,
        title: '已完成的 Issue',
        url: 'https://git.example/a/b/issues/2',
        status: 'done',
        prUrl: done.prUrl,
        prState: 'merged',
        lastRun: lastResponse,
        createdAt: old.toISOString(),
        updatedAt: recent.toISOString(),
      },
      {
        id: queued.id,
        repoId: project.id,
        ref: project.ref,
        number: 1,
        title: null,
        url: 'https://git.example/a/b/issues/1',
        status: 'queued',
        prUrl: null,
        prState: null,
        lastRun: null,
        createdAt: old.toISOString(),
        updatedAt: old.toISOString(),
      },
    ])
    expect(await (await request(`/api/issues/${done.id}/runs`)).json()).toEqual([
      { ...lastResponse, taskDir: null },
      {
        id: first.id,
        worker: 'worker1',
        taskDir: '/tasks/first',
        startedAt: old.toISOString(),
        endedAt: old.toISOString(),
        exitCode: 1,
        error: 'failed',
        summary: null,
        reportResult: null,
        logTail: null,
      },
    ])
    expect(await (await request(`/api/issues/${queued.id}/runs`)).json()).toEqual([])
    for (const id of ['0', '-1', 'abc', '1.5', '999', '9007199254740992']) {
      const response = await request(`/api/issues/${id}/runs`)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'Issue 不存在' })
    }
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test.each([false, true])('状态接口在提供 status=%s 时返回当前轮询状态', async (provided) => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-status-api-'))
  const { db, close } = await openDatabase(dir)
  const status: ServeStatus = {
    worker: 'worker1',
    interval: 60,
    timeout: 90,
    startedAt: new Date('2026-11-13T00:00:00Z'),
    lastPollAt: null,
    lastPollError: null,
  }
  const app = createApp(db, { workspace: dir, ...(provided ? { status: () => status } : {}) })
  try {
    const password = await ensurePassword(db)
    const login = await app.request('/login', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const headers = { host: 'localhost', cookie: login.headers.get('set-cookie')!.split(';')[0]! }
    const initial = await app.request('/api/status', { headers })
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({
      watch: provided ? { ...status, startedAt: status.startedAt.toISOString() } : null,
    })
    status.lastPollAt = new Date('2026-11-14T00:00:00Z')
    status.lastPollError = '轮询失败'
    expect(await (await app.request('/api/status', { headers })).json()).toEqual({
      watch: provided
        ? {
            ...status,
            startedAt: status.startedAt.toISOString(),
            lastPollAt: '2026-11-14T00:00:00.000Z',
          }
        : null,
    })
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('服务端页面渲染真实数据并转义外部内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-pages-'))
  const { db, close } = await openDatabase(dir)
  const time = new Date(2026, 10, 14, 12)
  const app = createApp(db, { workspace: dir, now: () => time.getTime() })
  try {
    const password = await ensurePassword(db)
    const login = await app.request('/login', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const headers = { host: 'localhost', cookie: login.headers.get('set-cookie')!.split(';')[0]! }
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'secret1234',
        enabled: true,
        createdAt: time,
        updatedAt: time,
      })
      .returning()
      .get()
    const records = (['running', 'queued', 'failed', 'done'] as const).map((status, n) =>
      db
        .insert(issues)
        .values({
          repoId: repo.id,
          number: n + 1,
          title: n === 2 ? '<script>alert(1)</script>' : `标题${n}`,
          status,
          prUrl: n === 2 ? 'javascript:alert(1)' : n === 3 ? 'https://github.com/a/b/pull/3' : null,
          prState: n === 3 ? 'merged' : null,
          createdAt: time,
          updatedAt: time,
        })
        .returning()
        .get(),
    )
    const request = (path: string) => app.request(path, { headers })
    const home = await request('/')
    const html = await home.text()
    expect(home.status).toBe(200)
    expect(home.headers.get('content-security-policy')).toContain("style-src 'self'")
    expect(html).toContain('概览')
    expect(html).toContain('github:a/b')
    expect(html).toContain('标题0')
    expect(html).toContain('标题1')
    expect(html).not.toContain('<script>alert')
    for (const path of [
      '/',
      '/repos',
      `/repos/${repo.id}`,
      `/issues/${records[2]!.id}`,
      '/login',
    ]) {
      const page = await request(path)
      expect(await page.text()).not.toContain(' style="')
    }
    const filtered = await (await request(`/repos/${repo.id}?status=failed`)).text()
    expect(filtered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(filtered).not.toContain('标题0')
    expect(filtered).not.toContain('href="javascript:alert(1)"')
    const list = await (await request('/issues')).text()
    expect(list).toContain('已合并')
    const donePage = await (await request(`/issues/${records[3]!.id}`)).text()
    expect(donePage).toContain('已合并')
    expect(donePage).toContain('查看 PR ↗')
    const emptyPage = await (await request(`/issues/${records[0]!.id}`)).text()
    expect(emptyPage).toContain('暂无 PR')
    const unsafePage = await (await request(`/issues/${records[2]!.id}`)).text()
    expect(unsafePage).not.toContain('href="javascript:alert(1)"')
    for (const path of [
      '/repos/invalid',
      '/repos/999',
      '/issues/invalid',
      '/issues/999',
      '/missing',
    ])
      expect((await request(path)).status).toBe(404)
    expect(await (await request('/repos?notice=untrusted-marker')).text()).not.toContain(
      'untrusted-marker',
    )
    expect(await (await request('/api/missing')).json()).toEqual({ error: '资源不存在' })
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('执行日志接口鉴权、路径校验、截断和打码，页面转义摘要', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-log-api-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir, secrets: () => ['repo-secret', 'llm-secret'] })
  try {
    expect((await app.request('/api/runs/1/log', { headers: { host: 'localhost' } })).status).toBe(
      401,
    )
    expect((await app.request('/runs/1/log', { headers: { host: 'localhost' } })).status).toBe(302)
    const password = await ensurePassword(db)
    const login = await app.request('/login', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const headers = { host: 'localhost', cookie: login.headers.get('set-cookie')!.split(';')[0]! }
    const request = (path: string) => app.request(path, { headers })
    for (const id of ['bad', '999'])
      expect(await (await request(`/api/runs/${id}/log`)).json()).toEqual({
        error: '执行记录不存在',
      })
    const now = new Date()
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'repo-secret',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    const issue = db
      .insert(issues)
      .values({ repoId: repo.id, number: 1, status: 'done', createdAt: now, updatedAt: now })
      .returning()
      .get()
    const run = db
      .insert(runs)
      .values({
        issueId: issue.id,
        worker: 'worker',
        startedAt: now,
        summary: '<script>alert(1)</script>',
        reportResult: '完成',
        logTail: '末尾',
      })
      .returning()
      .get()
    const path = `/api/runs/${run.id}/log`
    expect((await request('/runs/999/log')).status).toBe(404)
    expect(await (await request(path)).json()).toEqual({ error: '日志已清理' })
    db.update(runs).set({ taskDir: '/tmp/outside' }).where(eq(runs.id, run.id)).run()
    expect(await (await request(path)).json()).toEqual({ error: '日志已清理' })
    const taskDir = join(dir, 'tasks', 'one')
    db.update(runs).set({ taskDir }).where(eq(runs.id, run.id)).run()
    expect(await (await request(path)).json()).toEqual({ error: '日志已清理' })
    await Bun.write(join(taskDir, 'task.log'), 'repo-secret llm-secret')
    const response = await request(path)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toBe('*** ***')
    expect(response.headers.get('X-Log-Offset')).toBe('22')
    expect(response.headers.get('X-Run-Ended')).toBe('false')
    const partial = await request(`${path}?offset=12`)
    expect(await partial.text()).toBe('***')
    expect(partial.headers.get('X-Log-Offset')).toBe('22')
    expect(await (await request(`${path}?offset=100`)).text()).toBe('')
    for (const offset of ['-1', '1.5', '', 'abc', '9007199254740992']) {
      const invalid = await request(`${path}?offset=${offset}`)
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'offset 无效' })
    }
    await Bun.write(join(taskDir, 'task.log'), `${'x'.repeat(5 * 1024 * 1024)}repo-secret`)
    const chunk = await request(`${path}?offset=0`)
    expect((await chunk.arrayBuffer()).byteLength).toBe(1024 * 1024)
    expect(chunk.headers.get('X-Log-Offset')).toBe(String(1024 * 1024))
    db.update(runs).set({ endedAt: now }).where(eq(runs.id, run.id)).run()
    expect((await request(`${path}?offset=0`)).headers.get('X-Run-Ended')).toBe('true')
    const long = await (await request(path)).text()
    expect(long.startsWith('（日志较长，仅显示最后 5 MB）\n')).toBe(true)
    expect(long.endsWith('***')).toBe(true)
    const history = await (await request(`/api/issues/${issue.id}/runs`)).json()
    expect(history[0]).toMatchObject({
      summary: '<script>alert(1)</script>',
      reportResult: '完成',
      logTail: '末尾',
    })
    const html = await (await request(`/issues/${issue.id}`)).text()
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain(`href="/runs/${run.id}/log"`)
    expect(html).toContain('codex：完成')
    expect(html).not.toContain('日志末尾')
    expect(html).toContain('完整时间线')
    const logPage = await (await request(`/runs/${run.id}/log`)).text()
    expect(logPage).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(logPage).toContain('Pi 结论')
    expect(logPage).toContain('codex：完成')
    expect(logPage).toContain('跟随最新')
    expect(logPage).toContain('download')
    db.update(issues)
      .set({ lastRunId: run.id, status: 'running' })
      .where(eq(issues.id, issue.id))
      .run()
    const runningPage = await (await request('/')).text()
    expect(runningPage).toContain(`href="/runs/${run.id}/log">实时日志`)
    db.update(issues).set({ status: 'failed' }).where(eq(issues.id, issue.id)).run()
    const failedPage = await (await request('/')).text()
    expect(failedPage).toContain(`href="/runs/${run.id}/log">查看日志`)
    await Bun.write(join(taskDir, 'task.log'), '中文')
    const first = await (await request(`${path}?offset=1`)).arrayBuffer()
    expect([...new Uint8Array(first)]).toEqual([...Buffer.from('中文').subarray(1)])
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('事件接口鉴权与404、非法偏移、完整行推进、每文件1MB、脱敏和结束状态，页面与时间线图标、单行展开和卡片结构可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-events-api-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir, secrets: () => ['repo-secret', 'llm-secret', ''] })
  const host = { host: 'localhost' }
  try {
    expect((await app.request('/api/runs/1/events', { headers: host })).status).toBe(401)
    for (const path of ['/timeline.js', '/run-log.js'])
      expect((await app.request(path, { headers: host })).status).toBe(302)
    db.insert(sessions)
      .values({
        id: hashToken('events-session'),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })
      .run()
    const headers = { ...host, cookie: 'workling_session=events-session' }
    const request = (path: string) => app.request(path, { headers })
    for (const id of ['bad', '0', '999']) {
      const response = await request(`/api/runs/${id}/events`)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: '执行记录不存在' })
    }
    const now = new Date()
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'repo-secret',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    const issue = db
      .insert(issues)
      .values({ repoId: repo.id, number: 1, status: 'running', createdAt: now, updatedAt: now })
      .returning()
      .get()
    const run = db
      .insert(runs)
      .values({ issueId: issue.id, worker: 'worker', startedAt: now })
      .returning()
      .get()
    const path = `/api/runs/${run.id}/events`
    expect(await (await request(path)).json()).toEqual({ error: '日志已清理' })
    db.update(runs).set({ taskDir: '/tmp/outside' }).where(eq(runs.id, run.id)).run()
    expect(await (await request(path)).json()).toEqual({ error: '日志已清理' })
    const taskDir = join(dir, 'tasks', 'events')
    db.update(runs).set({ taskDir }).where(eq(runs.id, run.id)).run()
    await mkdir(taskDir, { recursive: true })
    expect(await (await request(path)).json()).toEqual({
      fallback: null,
      workling: { offset: 0, lines: [] },
      pi: { offset: 0, lines: [] },
      ended: false,
    })
    for (const key of ['workling', 'pi']) {
      for (const offset of ['-1', '1.2', '', 'bad', '9007199254740992']) {
        const response = await request(`${path}?${key}=${offset}`)
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'offset 无效' })
      }
    }
    const first = '{"text":"中文 repo-secret"}\n'
    const second = '{"text":"llm-secret"}\n'
    await Bun.write(join(taskDir, 'workling-events.jsonl'), first + second.slice(0, -1))
    await Bun.write(join(taskDir, 'pi-events.jsonl'), second)
    const one = await (await request(path)).json()
    expect(one).toEqual({
      fallback: null,
      workling: { offset: Buffer.byteLength(first), lines: ['{"text":"中文 ***"}'] },
      pi: { offset: Buffer.byteLength(second), lines: ['{"text":"***"}'] },
      ended: false,
    })
    expect(
      await (await request(`${path}?workling=${one.workling.offset}&pi=${one.pi.offset}`)).json(),
    ).toEqual({
      fallback: null,
      workling: { offset: one.workling.offset, lines: [] },
      pi: { offset: one.pi.offset, lines: [] },
      ended: false,
    })
    await Bun.write(join(taskDir, 'workling-events.jsonl'), first + second)
    expect(
      (await (await request(`${path}?workling=${one.workling.offset}`)).json()).workling,
    ).toEqual({
      offset: Buffer.byteLength(first + second),
      lines: ['{"text":"***"}'],
    })
    expect((await (await request(`${path}?workling=9999&pi=9999`)).json()).workling).toEqual({
      offset: 9999,
      lines: [],
    })
    const line = `${JSON.stringify({ text: 'x'.repeat(1000) })}\n`
    const data = line.repeat(1100)
    for (const file of ['workling-events.jsonl', 'pi-events.jsonl'])
      await Bun.write(join(taskDir, file), data)
    db.update(runs).set({ endedAt: now }).where(eq(runs.id, run.id)).run()
    const limited = await (await request(path)).json()
    for (const part of [limited.workling, limited.pi]) {
      expect(part.offset).toBe(
        Math.floor((1024 * 1024) / Buffer.byteLength(line)) * Buffer.byteLength(line),
      )
      expect(part.offset).toBeLessThanOrEqual(1024 * 1024)
      expect(part.lines.every((l: string) => JSON.parse(l).text.length === 1000)).toBe(true)
    }
    expect(limited.ended).toBe(true)
    const rest = await (await request(`${path}?workling=${limited.workling.offset}`)).json()
    expect(rest.workling.offset).toBe(Buffer.byteLength(data))
    const oversized = '中'.repeat(700000)
    await Bun.write(join(taskDir, 'workling-events.jsonl'), oversized)
    expect((await (await request(path)).json()).workling).toEqual({ offset: 0, lines: [] })
    await Bun.write(join(taskDir, 'workling-events.jsonl'), oversized + '\n' + first)
    const skipped = (await (await request(path)).json()).workling
    expect(skipped).toEqual({
      offset: Buffer.byteLength(oversized) + 1,
      lines: [JSON.stringify({ type: 'oversized_line', bytes: Buffer.byteLength(oversized) })],
    })
    expect((await (await request(`${path}?workling=${skipped.offset}`)).json()).workling).toEqual({
      offset: Buffer.byteLength(oversized + '\n' + first),
      lines: ['{"text":"中文 ***"}'],
    })
    for (const asset of ['/timeline.js', '/run-log.js']) {
      const response = await request(asset)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      const source = await response.text()
      expect(source).not.toContain('innerHTML')
      if (asset === '/run-log.js') {
        for (const part of [
          'timeline-icon',
          'timeline-body',
          'timeline-row',
          'timeline-command',
          'timeline-status',
          'timeline-codex-card',
          'timeline-model',
          'timeline-latest',
          '展开 codex 输出',
          'scrollIntoView',
        ])
          expect(source).toContain(part)
        expect(source).not.toContain('timeline.scrollTop')
        expect(source).not.toContain('完整命令与输出')
      }
    }
    const css = await (await request('/style.css')).text()
    expect(css).toMatch(/\.run-timeline\s*\{\s*padding: 0;\s*\}/)
    expect(css).toContain('grid-template-columns: repeat(5, minmax(0, 1fr))')
    expect(css).toContain('border-bottom: 0.5px solid')
    expect(css).toContain('--pro-bg:')
    const html = await (await request(`/runs/${run.id}/log`)).text()
    expect(html.match(/<li data-phase="[0-4]"/g)).toHaveLength(5)
    expect(html).toContain('<ol class="run-phases" aria-label="执行阶段">')
    expect(html).toContain('class="row log-toolbar"')
    for (const text of [
      '执行阶段',
      '准备',
      '读取 Issue',
      'codex 实现',
      '核对',
      '交付 PR',
      '全部',
      '命令',
      '文件',
      '说明',
      '错误',
      '原始日志',
      'id="run-timeline"',
      'data-status=',
      '<script type="module" src="/run-log.js?v=',
      '<pre id="run-log" hidden',
    ])
      expect(html).toContain(text)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('旧日志 fallback 仅在首次且没有结构化事件时返回，扫描全部 Pi 事件、最后 1 MB 并打码', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-fallback-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir, secrets: () => ['secret'] })
  const now = new Date()
  try {
    db.insert(sessions)
      .values({
        id: hashToken('fallback'),
        createdAt: now,
        expiresAt: new Date(Date.now() + 60000),
      })
      .run()
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'secret',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    const issue = db
      .insert(issues)
      .values({ repoId: repo.id, number: 3, status: 'failed', createdAt: now, updatedAt: now })
      .returning()
      .get()
    const taskDir = join(dir, 'tasks', 'old')
    const run = db
      .insert(runs)
      .values({
        issueId: issue.id,
        worker: 'w',
        startedAt: now,
        endedAt: now,
        taskDir,
        exitCode: 1,
        logTail: '<script>tail</script>',
      })
      .returning()
      .get()
    const headers = { host: 'localhost', cookie: 'workling_session=fallback' }
    const request = (path: string) => app.request(path, { headers })
    const path = `/api/runs/${run.id}/events`
    expect((await request(path)).status).toBe(404)
    await Bun.write(join(taskDir, 'task.log'), 'secret\n中文')
    expect((await (await request(path)).json()).fallback).toEqual({ lines: ['***', '中文'] })
    for (const query of ['workling=1', 'pi=1', 'workling=1&pi=1'])
      expect((await (await request(`${path}?${query}`)).json()).fallback).toBeNull()
    await Bun.write(
      join(taskDir, 'pi-events.jsonl'),
      'bad\nnull\n{}\n{"type":7}\n{"type":"session"}\n',
    )
    expect((await (await request(path)).json()).fallback).toEqual({ lines: ['***', '中文'] })
    await Bun.write(join(taskDir, 'task.log'), 'x'.repeat(1024 * 1024) + 'secret\n')
    const tail = (await (await request(path)).json()).fallback.lines.join('\n')
    expect(tail).toBe('x'.repeat(1024 * 1024 - 7) + '***\n')
    await Bun.write(
      join(taskDir, 'pi-events.jsonl'),
      '{"type":"session"}\n'.repeat(60000) + '{"type":"agent_start"}\n',
    )
    expect((await (await request(path)).json()).fallback).toBeNull()
    await rm(join(taskDir, 'pi-events.jsonl'))
    await Bun.write(join(taskDir, 'workling-events.jsonl'), '')
    expect((await (await request(path)).json()).fallback).toBeNull()
    db.insert(runs)
      .values({
        issueId: issue.id,
        worker: 'old',
        startedAt: new Date(0),
        endedAt: now,
        logTail: 'old-tail',
      })
      .run()
    const html = await (await request(`/issues/${issue.id}`)).text()
    expect(html).toContain('<details class="run-process" open="">')
    expect(html).toContain('<details class="run-process"><summary>执行过程</summary>')
    expect(html.match(/class="run-timeline compact"/g)).toHaveLength(2)
    expect(html).toContain('data-limit="8"')
    expect(html).toContain('data-ended="true" data-status="failed"')
    expect(html).toContain('data-log-tail="&lt;script&gt;tail&lt;/script&gt;"')
    expect(html).not.toContain('<pre>&lt;script&gt;tail')
    expect(html).not.toContain('日志末尾')
    expect(html).toContain(`href="/runs/${run.id}/log">完整时间线`)
    expect(html).toContain(`href="/runs/${run.id}/log">查看完整时间线`)
    expect(html).toContain(assetUrl('run-log.js'))
    expect(html).not.toContain('data-autorefresh="15"')
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Pi 配置接口鉴权、严格校验与脱敏，设置页包含表单且不泄漏密钥', async () => {
  const { readPiSettings, updatePiSettings } = await import('../src/config/pi.ts')
  const dir = await mkdtemp(join(tmpdir(), 'workling-settings-api-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir })
  const host = { host: 'localhost' }
  const path = '/api/settings/pi'
  try {
    for (const method of ['GET', 'PATCH'])
      expect(
        (
          await app.request(path, {
            method,
            headers: { ...host, 'content-type': 'application/json' },
            ...(method === 'PATCH' ? { body: '{}' } : {}),
          })
        ).status,
      ).toBe(401)
    expect((await app.request('/settings', { headers: host })).status).toBe(302)
    db.insert(sessions)
      .values({
        id: hashToken('pi-settings-session'),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })
      .run()
    const headers = { ...host, cookie: 'workling_session=pi-settings-session' }
    const patch = (body: unknown) =>
      app.request(path, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await (await app.request(path, { headers })).json()).llmApiKey).toBeNull()
    expect((await app.request(path, { method: 'PATCH', headers, body: '{}' })).status).toBe(415)
    const badJson = await app.request(path, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{',
    })
    expect(badJson.status).toBe(400)
    expect(await badJson.json()).toEqual({ error: 'JSON 格式无效' })
    for (const body of [
      {},
      null,
      [],
      { unknown: true },
      { model: 1 },
      { model: null },
      { effort: null },
      { gitName: null },
    ]) {
      const response = await patch(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: '参数无效' })
    }
    for (const body of [
      { model: ' ' },
      { effort: 'max' },
      { llmBaseUrl: 'http://external.example' },
      { gitEmail: 'bad' },
    ]) {
      const response = await patch(body)
      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain(Object.keys(body)[0])
    }
    const response = await patch({
      model: 'custom',
      effort: 'high',
      piModel: 'pi-custom',
      llmBaseUrl: 'https://llm.example/v1/',
      llmApiKey: 'distinctive-api-secret',
      llmApi: 'openai-completions',
      gitName: 'bot',
      gitEmail: 'bot@example.com',
    })
    expect(response.status).toBe(200)
    const expected = { ...readPiSettings(db), llmApiKey: '****cret' }
    expect(await response.json()).toEqual(expected)
    expect(await (await app.request(path, { headers })).json()).toEqual(expected)
    expect(await (await patch({ llmApiKey: '', model: 'updated' })).json()).toMatchObject({
      model: 'updated',
      llmApiKey: '****cret',
    })
    const page = await app.request('/settings?notice=saved', { headers })
    expect(page.status).toBe(200)
    const html = await page.text()
    for (const value of [
      'id="pi-settings-form"',
      'id="codex-form"',
      'id="git-form"',
      '未提供启动参数',
      'role="alert"',
      'placeholder="****cret"',
      '留空表示不修改',
      '设置已保存',
      '保存后下一轮轮询生效，运行中的任务不受影响',
      'href="/settings"',
    ])
      expect(html).toContain(value)
    expect(html).not.toContain('distinctive-api-secret')
    expect(html).not.toContain('value="****cret"')
    expect(
      await (await app.request('/settings?notice=untrusted-marker', { headers })).text(),
    ).not.toContain('untrusted-marker')
    expect((await patch({ piModel: null, llmBaseUrl: null })).status).toBe(200)
    expect(readPiSettings(db)).toMatchObject({ piModel: null, llmBaseUrl: null, llmApiKey: null })
    updatePiSettings(db, { llmBaseUrl: 'https://llm.example', llmApiKey: 'short' })
    expect((await (await app.request(path, { headers })).json()).llmApiKey).toBe('****')
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Docker 设置校验在写库前拒绝清空地址，其余有效修改仍可保存', async () => {
  const { readPiSettings, updatePiSettings } = await import('../src/config/pi.ts')
  const { piSettings } = await import('../src/db/schema.ts')
  const dir = await mkdtemp(join(tmpdir(), 'workling-docker-settings-'))
  const { db, close } = await openDatabase(dir)
  updateExecutorSettings(db, { sandbox: 'docker' })
  const app = createApp(db, { workspace: dir })
  try {
    db.insert(sessions)
      .values({
        id: hashToken('docker-settings'),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })
      .run()
    const patch = (body: unknown) =>
      app.request('/api/settings/pi', {
        method: 'PATCH',
        headers: {
          host: 'localhost',
          cookie: 'workling_session=docker-settings',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    expect((await patch({ model: 'custom' })).status).toBe(400)
    expect(db.select().from(piSettings).all()).toEqual([])
    const configured = updatePiSettings(db, {
      llmBaseUrl: 'https://llm.example',
      llmApiKey: 'secret',
    })
    const before = db.select().from(piSettings).get()
    const rejected = await patch({ model: 'lost', llmBaseUrl: null })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'docker 沙箱必须配置 LLM 接入地址' })
    expect(db.select().from(piSettings).get()).toEqual(before)
    expect(readPiSettings(db)).toEqual(configured)
    expect((await patch({ model: 'custom', llmApiKey: '' })).status).toBe(200)
    expect(readPiSettings(db)).toEqual({ ...configured, model: 'custom' })
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('执行器接口鉴权、读取默认值、严格校验和合并保存，Docker 与 Pi 地址相互约束', async () => {
  const { updatePiSettings } = await import('../src/config/pi.ts')
  const dir = await mkdtemp(join(tmpdir(), 'workling-executor-api-'))
  const { db, close } = await openDatabase(dir)
  const app = createApp(db, { workspace: dir })
  const path = '/api/settings/executor'
  try {
    for (const method of ['GET', 'PATCH'])
      expect(
        (
          await app.request(path, {
            method,
            headers: { host: 'localhost', 'content-type': 'application/json' },
            ...(method === 'PATCH' ? { body: '{}' } : {}),
          })
        ).status,
      ).toBe(401)
    db.insert(sessions)
      .values({
        id: hashToken('executor-session'),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })
      .run()
    const headers = {
      host: 'localhost',
      cookie: 'workling_session=executor-session',
      'content-type': 'application/json',
    }
    const patch = (body: unknown) =>
      app.request(path, { method: 'PATCH', headers, body: JSON.stringify(body) })
    expect(await (await app.request(path, { headers })).json()).toEqual(readExecutorSettings(db))
    const badJson = await app.request(path, { method: 'PATCH', headers, body: '{' })
    expect(badJson.status).toBe(400)
    expect(await badJson.json()).toEqual({ error: 'JSON 格式无效' })
    for (const body of [
      {},
      null,
      [],
      { unknown: true },
      { sandbox: null },
      { concurrency: '5' },
      { taskCpus: '2' },
      { taskPids: '64' },
      { taskMemory: null },
      { taskNetwork: 1 },
    ]) {
      const response = await patch(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: '参数无效' })
    }
    for (const body of [
      { sandbox: 'codex' },
      { sandbox: 'invalid' },
      { concurrency: 0 },
      { concurrency: 33 },
      { concurrency: 1.5 },
      { taskCpus: 0 },
      { taskPids: 64.5 },
      { taskMemory: '4G' },
      { taskImage: ' ' },
      { taskNetwork: '' },
    ]) {
      const response = await patch(body)
      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain(Object.keys(body)[0])
    }
    const before = readExecutorSettings(db)
    const rejected = await patch({ sandbox: 'docker' })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'docker 沙箱必须先配置 LLM 接入地址' })
    expect(readExecutorSettings(db)).toEqual(before)
    updatePiSettings(db, { llmBaseUrl: 'https://llm.example', llmApiKey: 'secret' })
    const config = {
      concurrency: 5,
      sandbox: 'docker',
      taskImage: 'custom:tag',
      taskCpus: 1.5,
      taskMemory: '512m',
      taskPids: 64,
      taskNetwork: 'workling',
    }
    const saved = await patch(config)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(config)
    expect(await (await app.request(path, { headers })).json()).toEqual(config)
    expect(await (await patch({ taskNetwork: null })).json()).toEqual({
      ...config,
      taskNetwork: null,
    })
    const piRejected = await app.request('/api/settings/pi', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ llmBaseUrl: null }),
    })
    expect(piRejected.status).toBe(400)
    expect(await piRejected.json()).toEqual({ error: 'docker 沙箱必须配置 LLM 接入地址' })
    const html = await (await app.request('/settings', { headers })).text()
    for (const value of [
      'id="executor-settings-form"',
      '保存执行器设置',
      '本机进程',
      'Docker 容器',
      'value="custom:tag"',
      'value="1.5"',
      '留空表示 Docker 默认',
      '切换只影响之后拉起的任务；Docker 需本机已构建镜像且已配置 LLM 接入地址',
    ])
      expect(html).toContain(value)
    expect((await patch({ sandbox: 'none' })).status).toBe(200)
    expect(
      (
        await app.request('/api/settings/pi', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ llmBaseUrl: null }),
        })
      ).status,
    ).toBe(200)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('任务页组合过滤、回退非法参数并转义外部标题，概览显示名额与失败建议', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-p1-'))
  const { db, close } = await openDatabase(dir)
  updateExecutorSettings(db, { concurrency: 2 })
  const now = new Date('2026-11-15T12:00:00Z')
  const status: ServeStatus = {
    worker: 'p1-worker',
    interval: 60,
    timeout: 90,
    startedAt: now,
    lastPollAt: new Date(now.getTime() - 15000),
    lastPollError: null,
  }
  const app = createApp(db, {
    workspace: dir,
    now: () => now.getTime(),
    status: () => status,
    startup: {
      workspace: '/p1-workspace',
      worker: 'p1-worker',
      host: '127.0.0.1',
      port: 7420,
      allowedHosts: [],
      secureCookie: false,
    },
  })
  try {
    const password = await ensurePassword(db)
    const login = await app.request('/login', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const headers = { host: 'localhost', cookie: login.headers.get('set-cookie')!.split(';')[0]! }
    const request = async (path: string) => (await app.request(path, { headers })).text()
    const projects = ['alpha', 'beta'].map((name) =>
      db
        .insert(repos)
        .values({
          ref: `github:a/${name}`,
          platform: 'github',
          host: 'github.com',
          path: `a/${name}`,
          token: 'repo-secret-1234',
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get(),
    )
    const records = [
      { title: 'Active task', status: 'running', repoId: projects[0]!.id },
      { title: 'Queued later', status: 'queued', repoId: projects[0]!.id },
      { title: 'Queued earliest', status: 'queued', repoId: projects[1]!.id },
      { title: '<script>Failed timeout</script>', status: 'failed', repoId: projects[0]!.id },
      { title: 'Failed PR', status: 'failed', repoId: projects[1]!.id },
      { title: 'Completed task', status: 'done', repoId: projects[0]!.id },
      { title: 'Canceled task', status: 'canceled', repoId: projects[1]!.id },
    ] as const
    const inserted = records.map((record, index) =>
      db
        .insert(issues)
        .values({
          ...record,
          number: index + 10,
          createdAt: now,
          updatedAt: new Date(now.getTime() - index * 60000),
        })
        .returning()
        .get(),
    )
    for (const index of [0, 3, 4]) {
      const issue = inserted[index]!
      const run = db
        .insert(runs)
        .values({
          issueId: issue.id,
          worker: 'p1-worker',
          startedAt: new Date(now.getTime() - 600000),
          endedAt: index === 0 ? null : now,
          error: index === 3 ? '超时' : index === 4 ? '未找到 PR' : null,
        })
        .returning()
        .get()
      db.update(issues).set({ lastRunId: run.id }).where(eq(issues.id, issue.id)).run()
    }
    const sample = pageData(db, now.getTime()).issues.find((issue) => issue.id === inserted[3]!.id)!
    const branches = [
      ['超时', '超时', '任务可能过大：拆分 Issue 或调大超时后重新打 workling:ready'],
      ['已取消', '已取消', '确认需要后重新打 workling:ready'],
      ['进程丢失', '进程丢失', '通常是机器重启或进程被结束，直接重试即可'],
      ['进程中断', '进程丢失', '通常是机器重启或进程被结束，直接重试即可'],
      ['内存不足（OOM）', '内存不足', '调大执行器内存后重试'],
      ['未找到 PR', '未建 PR', '查看 codex 回报中的阻塞原因，补充 Issue 描述后重试'],
      ['原始错误', '失败', '原始错误'],
    ]
    for (const [error, label, advice] of branches)
      expect(failureReason({ ...sample, lastRun: { ...sample.lastRun!, error: error! } })).toEqual({
        label,
        advice,
      })
    for (const error of [null, '']) {
      expect(
        failureReason({ ...sample, lastRun: { ...sample.lastRun!, error, exitCode: 7 } }),
      ).toEqual({ label: '退出码 7', advice: '查看日志定位失败步骤' })
      for (const exitCode of [null, 0])
        expect(
          failureReason({ ...sample, lastRun: { ...sample.lastRun!, error, exitCode } }),
        ).toEqual({ label: '失败', advice: '查看日志定位原因' })
    }
    expect(failureReason({ ...sample, lastRun: null })).toEqual({
      label: '失败',
      advice: '查看日志定位原因',
    })
    const table = (html: string) => html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'))
    for (const state of ['running', 'queued', 'failed', 'done', 'canceled']) {
      const body = table(await request(`/issues?status=${state}`))
      for (const record of records)
        expect(body.includes(record.title.replaceAll('<', '&lt;').replaceAll('>', '&gt;'))).toBe(
          record.status === state,
        )
    }
    const combined = table(await request(`/issues?status=queued&repo=${projects[0]!.id}&q=QUEUED`))
    expect(combined).toContain('Queued later')
    expect(combined).not.toContain('Queued earliest')
    expect(combined).toContain('队列第 2 位')
    for (const q of ['%2310', '10', '%20%2310%20']) {
      const body = table(await request(`/issues?q=${q}`))
      expect(body).toContain('Active task')
      expect(body).not.toContain('Queued later')
    }
    expect(table(await request('/issues?q=1'))).not.toContain('Active task')
    const all = await request('/issues?status=invalid&repo=999999')
    expect(table(all)).toContain('Active task')
    expect(table(all)).toContain('Completed task')
    expect(table(await request('/issues?repo=invalid'))).toContain('Canceled task')
    expect(all).toContain('&lt;script&gt;Failed timeout&lt;/script&gt;')
    expect(all).not.toContain('<script>Failed')
    expect(all).not.toMatch(/\sstyle\s*=/i)
    expect(all).toContain('id="issue-filter"')
    const retained = await request(`/issues?repo=${projects[0]!.id}&q=task`)
    expect(retained).toContain(`repo=${projects[0]!.id}&amp;q=task&amp;status=failed`)
    const overview = await request('/')
    expect(overview.match(/class="slot idle"/g)).toHaveLength(1)
    expect(overview).toContain('下一个：Queued earliest')
    expect(overview).toContain('名额 1 / 2')
    expect(overview).toContain('15 秒前')
    expect(overview).toContain('<progress')
    expect(overview).toContain('拆分 Issue')
    expect(overview).toContain('未建 PR')
    expect(overview).toContain('补充 Issue 描述后重试')
    const settings = await request('/settings')
    for (const id of ['codex-form', 'pi-settings-form', 'git-form', 'executor-settings-form'])
      expect(settings).toContain(`id="${id}"`)
    expect(settings).toContain('id="version-pill"')
    expect(settings).toContain('id="version-popover"')
    expect(settings).not.toContain('id="set-version"')
    expect(settings).not.toContain('<h2>版本与更新</h2>')
    expect(settings).not.toContain('<h2>版本与更新</h2>')
    expect(settings).toContain('/p1-workspace')
    expect(settings).toContain('WORKLING_WORKSPACE')
    for (const name of ['ready', 'queued', 'running', 'done', 'failed'])
      expect(settings).toContain(`workling:${name}`)
    expect(settings).not.toMatch(/\sstyle\s*=/i)
    expect(settings).not.toContain('repo-secret-1234')
    status.lastPollError = '<unsafe-error>'
    const warned = await request('/')
    expect(warned).toContain('class="health warn"')
    expect(warned).toContain('&lt;unsafe-error&gt;')
    updateExecutorSettings(db, { concurrency: 1 })
    expect(await request('/')).not.toContain('class="slot idle"')
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('执行器并发上限 PATCH 持久化，非法值返回 400，刷新页面显示新名额', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-concurrency-api-'))
  const { db, close } = await openDatabase(dir)
  const now = new Date()
  const app = createApp(db, {
    workspace: dir,
    status: () => ({
      worker: 'worker',
      interval: 60,
      timeout: 90,
      startedAt: now,
      lastPollAt: null,
      lastPollError: null,
    }),
  })
  try {
    db.insert(sessions)
      .values({
        id: hashToken('concurrency-session'),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60000),
      })
      .run()
    const headers = {
      host: 'localhost',
      cookie: 'workling_session=concurrency-session',
      'content-type': 'application/json',
    }
    const patch = (concurrency: unknown) =>
      app.request('/api/settings/executor', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ concurrency }),
      })
    const saved = await patch(5)
    expect(saved.status).toBe(200)
    expect((await saved.json()).concurrency).toBe(5)
    expect(readExecutorSettings(db).concurrency).toBe(5)
    for (const concurrency of [0, 33, 1.5, '5']) {
      const rejected = await patch(concurrency)
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toEqual({
        error:
          typeof concurrency === 'string' ? '参数无效' : `concurrency 的值无效：${concurrency}`,
      })
    }
    expect(readExecutorSettings(db).concurrency).toBe(5)
    const overview = await (await app.request('/', { headers })).text()
    expect(overview).toContain('并发 0 / 5')
    expect(overview).toContain('名额 0 / 5')
    expect(overview.match(/class="slot idle"/g)).toHaveLength(5)
    const settings = await (await app.request('/settings', { headers })).text()
    const input = settings.match(/<input[^>]*name="concurrency"[^>]*>/)?.[0]
    expect(input).toBeDefined()
    for (const attribute of [
      'type="number"',
      'min="1"',
      'max="32"',
      'step="1"',
      'required',
      'value="5"',
    ])
      expect(input).toContain(attribute)
    expect(settings).toContain('同时运行的任务数，保存后下一轮轮询生效')
    expect(settings.indexOf('name="concurrency"')).toBeLessThan(
      settings.indexOf('data-docker-only'),
    )
    expect(settings).toContain('muted-fieldset')
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('修改密码共享登录限流并保留当前会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workling-password-api-'))
  const { db, close } = await openDatabase(dir)
  let time = Date.now()
  const app = createApp(db, { workspace: dir, now: () => time })
  const post = (path: string, body: unknown, cookie = '') =>
    app.request(path, {
      method: 'POST',
      headers: { host: 'localhost', cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  try {
    const password = (await ensurePassword(db))!
    const next = 'a new password 123'
    expect(
      (await post('/api/password', { currentPassword: password, newPassword: next })).status,
    ).toBe(401)
    const login1 = await post('/login', { password })
    const login2 = await post('/login', { password })
    const cookie1 = login1.headers.get('set-cookie')!.split(';')[0]!
    const cookie2 = login2.headers.get('set-cookie')!.split(';')[0]!
    const change = (body: unknown) => post('/api/password', body, cookie1)
    for (const body of [
      { currentPassword: password, newPassword: 'short' },
      { currentPassword: password, newPassword: password },
      { currentPassword: password, newPassword: next, extra: true },
      { currentPassword: password, newPassword: 'x'.repeat(129) },
    ])
      expect((await change(body)).status).toBe(400)
    const badJson = await app.request('/api/password', {
      method: 'POST',
      headers: { host: 'localhost', cookie: cookie1, 'content-type': 'application/json' },
      body: '{',
    })
    expect(await badJson.json()).toEqual({ error: 'JSON 格式无效' })
    for (let i = 0; i < 5; i++) {
      const response = await change({ currentPassword: 'wrong', newPassword: next })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: '当前密码不正确' })
    }
    expect((await post('/login', { password })).status).toBe(429)
    expect((await change({ currentPassword: password, newPassword: next })).status).toBe(429)
    time += 15 * 60 * 1000
    const page = await (
      await app.request('/settings?notice=password', {
        headers: { host: 'localhost', cookie: cookie1 },
      })
    ).text()
    expect(page).toContain('id="set-password"')
    expect(page).toContain('href="#set-password"')
    expect(page).toContain('管理密码')
    expect(page).toContain('密码已修改，其他会话已退出')
    expect((await change({ currentPassword: password, newPassword: next })).status).toBe(204)
    expect(
      (await app.request('/api/repos', { headers: { host: 'localhost', cookie: cookie1 } })).status,
    ).toBe(200)
    expect(
      (await app.request('/api/repos', { headers: { host: 'localhost', cookie: cookie2 } })).status,
    ).toBe(401)
    expect((await post('/login', { password })).status).toBe(401)
    expect((await post('/login', { password: next })).status).toBe(204)
  } finally {
    close()
    await rm(dir, { recursive: true, force: true })
  }
}, 15000)
