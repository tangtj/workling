import { afterEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  utimes,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateUpdateChannel } from '../src/config/update.ts'
import { openDatabase } from '../src/db/index.ts'
import { issues, repos, sessions } from '../src/db/schema.ts'
import { hashToken } from '../src/web/auth.ts'
import { createApp } from '../src/web/app.ts'
import { run } from '../src/runtime/process.ts'
import { compareVersions, readVersion } from '../src/runtime/version.ts'
import { downloadTarball, listReleases, type UpdateFetch } from '../src/update/github.ts'
import {
  getJob,
  launchPaused,
  localVersionInfo,
  markHealthy,
  startUpdate,
  versionInfo,
} from '../src/update/index.ts'
import { readState, writeState, type UpdateState } from '../src/update/state.ts'

const dirs: string[] = []
const closers: (() => void)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'workling-update-'))
  dirs.push(dir)
  return dir
}
const release = (tag: string, extra = {}) => ({
  tag_name: tag,
  name: tag,
  body: 'notes',
  published_at: '2026-11-15T00:00:00Z',
  html_url: `https://github.com/a/b/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
})
const initial = (extra: Partial<UpdateState> = {}): UpdateState => ({
  current: 'v0.2.0',
  previous: 'v0.1.0',
  previousIsImage: true,
  backup: null,
  pending: false,
  attempts: 0,
  updatedAt: new Date().toISOString(),
  ...extra,
})
async function fixture(different: boolean | 'entrypoint' = false) {
  const dir = await temp()
  const appHome = join(dir, 'app'),
    imageRoot = join(dir, 'image'),
    source = join(dir, 'source'),
    data = join(dir, 'data')
  process.env.WORKLING_APP_HOME = appHome
  process.env.WORKLING_IMAGE_ROOT = imageRoot
  process.env.WORKLING_UPDATE_REPO = 'a/b'
  for (const path of [
    join(imageRoot, 'deploy/docker'),
    join(imageRoot, 'src/contract'),
    join(source, 'src/contract'),
    data,
    join(source, 'src'),
    join(source, 'worker'),
    join(source, 'drizzle/meta'),
    join(source, 'deploy/docker'),
  ])
    await mkdir(path, { recursive: true })
  for (const [name, content] of Object.entries({
    'package.json': '{}',
    'bun.lock': '{}',
    'src/cli.ts': '',
    'src/contract/spec.ts': 'export const CONTRACT_VERSION = 1',
    'worker/cli.ts': '',
    'drizzle/meta/_journal.json': '{}',
    'deploy/docker/Dockerfile': different === true ? 'FROM different' : 'FROM image',
    'deploy/docker/entrypoint.sh': different === 'entrypoint' ? 'different' : 'entrypoint',
  }))
    await writeFile(join(source, name), content)
  await writeFile(join(imageRoot, 'deploy/docker/Dockerfile'), 'FROM image')
  await writeFile(join(imageRoot, 'deploy/docker/entrypoint.sh'), 'entrypoint')
  await writeFile(join(imageRoot, 'src/contract/spec.ts'), 'export const CONTRACT_VERSION = 1')
  await writeFile(join(imageRoot, 'VERSION'), 'v0.1.0\n')
  const sqlite = new Database(join(data, 'workling.db'))
  sqlite.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('before update')")
  sqlite.close()
  const { db, close } = await openDatabase(data)
  closers.push(close)
  const archive = join(dir, 'source.tar.gz')
  await run(['tar', '-czf', archive, '-C', dir, 'source'])
  const calls: string[][] = []
  const fetch: UpdateFetch = async (url) =>
    url.includes('/releases?')
      ? Response.json([release('v0.2.0'), release('v0.1.0')])
      : new Response(await readFile(archive))
  const command: typeof run = async (args, options) => {
    calls.push(args)
    return args[0] === 'tar' ? run(args, options) : ''
  }
  const exits: number[] = []
  const options = {
    db,
    fetch,
    command,
    root: imageRoot,
    data,
    exit: (code: number) => {
      exits.push(code)
    },
  }
  return { dir, appHome, imageRoot, source, data, options, calls, exits, db }
}
async function settled(appHome: string) {
  const deadline = Date.now() + 5000
  while (existsSync(join(appHome, 'update.lock'))) {
    if (Date.now() > deadline) throw new Error('作业未完成')
    await Bun.sleep(10)
  }
  return getJob()!
}

test('readVersion 读取去空白版本，缺失与空文件返回 dev；正式版高于预发布', async () => {
  const dir = await temp()
  expect(readVersion(dir)).toBe('dev')
  await writeFile(join(dir, 'VERSION'), ' \n')
  expect(readVersion(dir)).toBe('dev')
  await writeFile(join(dir, 'VERSION'), ' v0.10.0\n')
  expect(readVersion(dir)).toBe('v0.10.0')
  expect(compareVersions('v0.10.0', 'v0.9.1')).toBe(1)
  expect(compareVersions('dev', 'v0.0.0')).toBe(-1)
  expect(compareVersions('v0.0.0', 'dev')).toBe(1)
  expect(compareVersions('v1.2.3-rc.1', 'v1.2.3')).toBe(-1)
  expect(compareVersions('dev', 'dev')).toBe(0)
})

test('Release 过滤 draft、prerelease 与非法 tag，按版本排序并缓存 20 分钟，force 跳过缓存', async () => {
  let calls = 0,
    time = 0
  const fetch: UpdateFetch = async (_url, init) => {
    calls++
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
    expect(new Headers(init?.headers).get('x-github-api-version')).toBe('2022-11-28')
    expect(new Headers(init?.headers).get('user-agent')).toBe('workling')
    expect(init?.proxy).toBe('http://proxy')
    return Response.json([
      release('v0.9.1'),
      release('v0.10.0', { body: 'x'.repeat(2100) }),
      release('v1.0.0', { draft: true }),
      release('v2.0.0', { prerelease: true }),
      release('bad'),
    ])
  }
  const options = { repo: 'a/b', token: 'secret', proxy: 'http://proxy', fetch, now: () => time }
  const releases = await listReleases(options)
  expect(releases.map((r) => r.tag)).toEqual(['v0.10.0', 'v0.9.1'])
  expect(releases[0]!.body.length).toBe(2000)
  await listReleases(options)
  expect(calls).toBe(1)
  time = 20 * 60_000
  await listReleases(options)
  expect(calls).toBe(2)
  await listReleases({ ...options, force: true })
  expect(calls).toBe(3)
})

test('Release 拒绝形状错误的响应与非法仓库', async () => {
  await expect(
    listReleases({ repo: 'a/b', fetch: async () => Response.json([{ tag_name: 123 }]) }),
  ).rejects.toThrow('响应格式无效')
  await expect(listReleases({ repo: '../a/b' })).rejects.toThrow('owner/repo')
})

test('下载拒绝非白名单与非 https 重定向，不转发 token 给 codeload，最多跟随 3 次', async () => {
  const dir = await temp()
  for (const location of ['https://evil.example/archive', 'http://codeload.github.com/archive']) {
    const fetch: UpdateFetch = async () =>
      new Response(null, { status: 302, headers: { location } })
    await expect(
      downloadTarball({ repo: 'a/b', ref: 'v0.2.0', dest: join(dir, 'bad'), fetch }),
    ).rejects.toThrow('允许范围')
  }
  let calls = 0
  const fetch: UpdateFetch = async (_url, init) => {
    calls++
    if (calls === 1)
      return new Response(null, {
        status: 302,
        headers: { location: 'https://codeload.github.com/a/b/legacy.tar.gz/v0.2.0' },
      })
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    return new Response('archive')
  }
  await downloadTarball({
    repo: 'a/b',
    ref: 'v0.2.0',
    token: 'secret',
    dest: join(dir, 'good'),
    fetch,
  })
  expect(await readFile(join(dir, 'good'), 'utf8')).toBe('archive')
  let redirects = 0
  await expect(
    downloadTarball({
      repo: 'a/b',
      ref: 'v0.2.0',
      dest: join(dir, 'loop'),
      fetch: async () => {
        redirects++
        return new Response(null, {
          status: 302,
          headers: { location: 'https://api.github.com/loop' },
        })
      },
    }),
  ).rejects.toThrow('重定向次数')
  expect(redirects).toBe(4)
})

test('下载超过 50 MB 时中止流并清除文件，也拒绝过大的 Content-Length', async () => {
  const dir = await temp()
  let cancelled = false,
    signal: AbortSignal | null | undefined
  const fetch: UpdateFetch = async (_url, init) => {
    signal = init?.signal
    return new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
  }
  const dest = join(dir, 'large')
  await expect(downloadTarball({ repo: 'a/b', ref: 'v0.2.0', dest, fetch })).rejects.toThrow(
    '50 MB',
  )
  expect(cancelled).toBe(true)
  expect(signal?.aborted).toBe(true)
  expect(existsSync(dest)).toBe(false)
  await expect(
    downloadTarball({
      repo: 'a/b',
      ref: 'v0.2.0',
      dest,
      fetch: async () =>
        new Response('a', { headers: { 'content-length': String(51 * 1024 * 1024) } }),
    }),
  ).rejects.toThrow('50 MB')
})

test('升级解压真实归档、安装依赖、备份 SQLite、原子切换并退出；第二个作业被拒绝', async () => {
  const f = await fixture()
  const active = await startUpdate({ target: 'v0.2.0', ...f.options })
  await expect(startUpdate({ target: 'v0.2.0', ...f.options })).rejects.toThrow('已有更新')
  await settled(f.appHome)
  expect(active.status).toBe('done')
  const target = join(f.appHome, 'releases/v0.2.0')
  expect(await readlink(join(f.appHome, 'current'))).toBe(target)
  expect(readVersion(target)).toBe('v0.2.0')
  expect(f.calls[1]).toEqual([
    'bun',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--production',
  ])
  const state = readState(f.appHome)!
  expect(state).toMatchObject({
    current: 'v0.2.0',
    previous: 'v0.1.0',
    previousIsImage: true,
    pending: true,
    attempts: 0,
  })
  const backup = new Database(state.backup!, { readonly: true })
  try {
    expect(backup.query('SELECT value FROM sample').get()).toEqual({ value: 'before update' })
  } finally {
    backup.close()
  }
  expect(active.logs.at(-1)).toBe('即将重启')
  expect(f.exits).toEqual([0])
  expect(existsSync(join(f.appHome, 'tmp/v0.2.0.tar.gz'))).toBe(false)
})

test('Dockerfile 不同则升级失败，状态与 current 保持不变，清理 partial 和下载文件', async () => {
  const f = await fixture(true)
  await mkdir(f.appHome, { recursive: true })
  writeState(f.appHome, initial())
  const before = await readFile(join(f.appHome, 'state.json'), 'utf8')
  const { symlink } = await import('node:fs/promises')
  await symlink(f.imageRoot, join(f.appHome, 'current'))
  await startUpdate({ target: 'v0.2.0', ...f.options })
  const active = await settled(f.appHome)
  expect(active.status).toBe('failed')
  expect(active.error).toContain('./update.sh v0.2.0')
  expect(await readlink(join(f.appHome, 'current'))).toBe(f.imageRoot)
  expect(await readFile(join(f.appHome, 'state.json'), 'utf8')).toBe(before)
  expect(existsSync(join(f.appHome, 'releases/v0.2.0.partial'))).toBe(false)
  expect(existsSync(join(f.appHome, 'tmp/v0.2.0.tar.gz'))).toBe(false)
  expect(f.exits).toEqual([])
})

test('拒绝不在 Release 中或不比当前新的 tag，文件锁冲突时不删除他人的锁', async () => {
  const f = await fixture()
  for (const tag of ['v0.1.0', 'v9.0.0', '../bad'])
    await expect(startUpdate({ target: tag, ...f.options })).rejects.toThrow()
  await writeFile(join(f.appHome, 'update.lock'), 'other')
  await expect(startUpdate({ target: 'v0.2.0', ...f.options })).rejects.toThrow('已有更新')
  expect(await readFile(join(f.appHome, 'update.lock'), 'utf8')).toBe('other')
})

test('依赖安装失败时不切换状态且删除 partial，错误中的更新 token 被脱敏', async () => {
  const f = await fixture()
  process.env.WORKLING_UPDATE_TOKEN = 'update-secret'
  const command: typeof run = (args, opts) =>
    args[0] === 'tar' ? run(args, opts) : Promise.reject(new Error('install update-secret failed'))
  await startUpdate({ target: 'v0.2.0', ...f.options, command })
  const active = await settled(f.appHome)
  expect(active.status).toBe('failed')
  expect(JSON.stringify(active)).not.toContain('update-secret')
  expect(readState(f.appHome)).toBeNull()
  expect(existsSync(join(f.appHome, 'current'))).toBe(false)
  expect(existsSync(join(f.appHome, 'releases/v0.2.0.partial'))).toBe(false)
})

test('markHealthy 只在 pending 且当前运行版本匹配时清零；状态文件严格验证', async () => {
  const f = await fixture()
  const s = initial({ pending: true, attempts: 2 })
  writeState(f.appHome, s)
  markHealthy(f.imageRoot)
  expect(readState(f.appHome)).toEqual(s)
  await writeFile(join(f.imageRoot, 'VERSION'), 'v0.2.0')
  markHealthy(f.imageRoot)
  expect(readState(f.appHome)).toMatchObject({
    pending: false,
    attempts: 0,
    lastSuccess: { tag: 'v0.2.0', at: expect.any(String) },
  })
  expect(Number.isNaN(Date.parse(readState(f.appHome)!.lastSuccess!.at))).toBe(false)
  expect(localVersionInfo(f.db, f.imageRoot).lastSuccess).toEqual(
    readState(f.appHome)!.lastSuccess!,
  )
  writeState(f.appHome, { ...s, pending: false })
  markHealthy(f.imageRoot)
  expect(readState(f.appHome)?.attempts).toBe(2)
  await writeFile(join(f.appHome, 'state.json'), '{"current":"../../bad"}')
  expect(() => readState(f.appHome)).toThrow('格式无效')
})

test('系统接口要求登录与 JSON、严格校验 tag，非 Docker 拒绝升级，版本信息不泄漏 token', async () => {
  const dir = await temp()
  const { db, close } = await openDatabase(dir)
  const cookie = 'test-session'
  db.insert(sessions)
    .values({
      id: hashToken(cookie),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .run()
  const app = createApp(db, { workspace: dir })
  const request = (
    path: string,
    method = 'GET',
    body?: string,
    loggedIn = true,
    contentType = 'application/json',
  ) =>
    app.request(path, {
      method,
      body,
      headers: {
        host: 'localhost',
        ...(loggedIn ? { cookie: `workling_session=${cookie}` } : {}),
        'content-type': contentType,
      },
    })
  try {
    for (const path of ['/api/system/version', '/api/system/job'])
      expect((await request(path, 'GET', undefined, false)).status).toBe(401)
    for (const path of ['/api/system/update', '/api/system/job/cancel'])
      expect((await request(path, 'POST', '{}', false)).status).toBe(401)
    expect((await request('/api/system/update', 'POST', '{"target":"v0.2.0"}')).status).toBe(409)
    for (const body of ['{"target":"../bad"}', '{"target":"v0.2.0","extra":true}', '{'])
      expect((await request('/api/system/update', 'POST', body)).status).toBe(400)
    expect((await request('/api/system/update', 'POST', '{}', true, 'text/plain')).status).toBe(415)
    expect((await request('/api/system/job/cancel', 'POST', '{}')).status).toBe(409)
    expect((await (await request('/api/settings')).json()).update.channel).toBe('stable')
    expect((await request('/api/settings/update', 'PATCH', '{"channel":"bad"}')).status).toBe(400)
    expect(
      (await request('/api/settings/update', 'PATCH', '{"channel":"edge","extra":true}')).status,
    ).toBe(400)
    expect(
      await (await request('/api/settings/update', 'PATCH', '{"channel":"edge"}')).json(),
    ).toEqual({ channel: 'edge' })
    expect((await (await request('/api/settings')).json()).update.channel).toBe('edge')
    await request('/api/settings/update', 'PATCH', '{"channel":"stable"}')
    expect(
      (
        await request(
          '/api/system/update',
          'POST',
          JSON.stringify({ target: 'v0.2.0', mode: 'invalid' }),
        )
      ).status,
    ).toBe(400)
    const empty = await (await request('/api/system/version')).json()
    expect(empty).toMatchObject({ repoConfigured: false, releases: [], mode: 'unsupported' })
    expect(empty.releasesUrl).toBeNull()
    process.env.WORKLING_UPDATE_REPO = 'invalid/repo/path'
    expect(localVersionInfo(db).releasesUrl).toBeNull()
    process.env.WORKLING_UPDATE_REPO = 'a/b'
    expect(localVersionInfo(db).releasesUrl).toBe('https://github.com/a/b/releases')
    process.env.WORKLING_UPDATE_TOKEN = 'top-secret-update-token'
    const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('top-secret-update-token'))
    const info = await request('/api/system/version?force=1')
    expect(info.status).toBe(200)
    const text = await info.text()
    expect(text).toContain('releaseError')
    expect(text).not.toContain('top-secret-update-token')
    const page = await request('/api/shell')
    const html = await page.text()
    expect(JSON.parse(html).version).toBe(readVersion())
    expect(html).not.toContain('set-version')
    expect(fetch).toHaveBeenCalledTimes(1)
    const local = await request('/api/system/version?local=1')
    expect(local.status).toBe(200)
    expect(await local.json()).toMatchObject({
      releasesUrl: 'https://github.com/a/b/releases',
      repoConfigured: true,
      mode: 'unsupported',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const now = new Date()
    const repo = db
      .insert(repos)
      .values({
        ref: 'github:a/b',
        platform: 'github',
        host: 'github.com',
        path: 'a/b',
        token: 'repo-token',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    db.insert(issues)
      .values({ repoId: repo.id, number: 1, status: 'running', createdAt: now, updatedAt: now })
      .run()
    const direct = await versionInfo({ db, fetch: async () => Response.json([release('v0.2.0')]) })
    expect(direct.hasUpdate).toBe(false)
    expect(direct.note).toBe('开发版本无法检查更新')
    expect(direct.runningTasks).toBe(1)
  } finally {
    close()
  }
})

test('成功升级保留 current、previous 与最近一个其他版本，数据库备份只保留最新十份', async () => {
  const f = await fixture()
  for (let i = 1; i <= 3; i++) {
    const dir = join(f.appHome, 'releases', `v0.0.${i}`)
    await mkdir(dir, { recursive: true })
    await utimes(dir, new Date(1000 * i), new Date(1000 * i))
  }
  await mkdir(join(f.appHome, 'releases/v0.0.4.partial'))
  await mkdir(join(f.appHome, 'tmp'))
  await writeFile(join(f.appHome, 'tmp/stale.tar.gz'), 'stale')
  const backups = join(f.data, 'backups')
  await mkdir(backups)
  for (let i = 0; i < 12; i++) {
    const file = join(backups, `workling-history-${i}.db`)
    await writeFile(file, 'old')
    await utimes(file, new Date(1000 * i), new Date(1000 * i))
  }
  await startUpdate({ target: 'v0.2.0', ...f.options })
  expect((await settled(f.appHome)).status).toBe('done')
  expect((await readdir(join(f.appHome, 'releases'))).sort()).toEqual(['v0.0.3', 'v0.2.0'])
  expect(existsSync(join(f.appHome, 'tmp'))).toBe(false)
  expect((await readdir(backups)).length).toBe(10)
  expect(existsSync(readState(f.appHome)!.backup!)).toBe(true)
  expect(existsSync(join(backups, 'workling-history-0.db'))).toBe(false)
})

async function addRunning(db: Parameters<typeof localVersionInfo>[0]) {
  const now = new Date()
  const repo = db
    .insert(repos)
    .values({
      ref: 'github:a/b',
      platform: 'github',
      host: 'github.com',
      path: 'a/b',
      token: '',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
  return db
    .insert(issues)
    .values({ repoId: repo.id, number: 1, status: 'running', createdAt: now, updatedAt: now })
    .returning()
    .get()
}

async function waiting() {
  const deadline = Date.now() + 5000
  while (getJob()?.status !== 'waiting') {
    if (getJob()?.status === 'failed' || Date.now() > deadline)
      throw new Error(`未进入等待：${JSON.stringify(getJob())}`)
    await Bun.sleep(5)
  }
}

function systemRequest(f: Awaited<ReturnType<typeof fixture>>) {
  const cookie = 'update-session'
  f.db
    .insert(sessions)
    .values({
      id: hashToken(cookie),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .run()
  const app = createApp(f.db, { workspace: f.data })
  return (path: string, body: unknown = {}) =>
    app.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        host: 'localhost',
        cookie: `workling_session=${cookie}`,
        'content-type': 'application/json',
      },
    })
}

test('Dockerfile 一致但 entrypoint.sh 不同则拒绝在线更新', async () => {
  const f = await fixture('entrypoint')
  await startUpdate({ target: 'v0.2.0', ...f.options })
  const active = await settled(f.appHome)
  expect(active.status).toBe('failed')
  expect(active.error).toContain('deploy/docker/entrypoint.sh')
  expect(active.error).toContain('./update.sh v0.2.0')
  expect(f.calls).toHaveLength(1)
  expect(f.exits).toEqual([])
})

test('运行环境指纹文件缺失时报出具体的无效文件', async () => {
  for (const file of ['deploy/docker/Dockerfile', 'deploy/docker/entrypoint.sh']) {
    const f = await fixture()
    await rm(join(f.source, file))
    await run(['tar', '-czf', join(f.dir, 'source.tar.gz'), '-C', f.dir, 'source'])
    await startUpdate({ target: 'v0.2.0', ...f.options })
    const active = await settled(f.appHome)
    expect(active.status).toBe('failed')
    expect(active.error).toBe(`版本缺少有效文件：${file}`)
  }
})

test('依赖安装合并更新代理与现有环境，保留 PATH', async () => {
  const f = await fixture()
  process.env.WORKLING_UPDATE_PROXY = 'http://proxy.example:8080'
  let installs = 0
  const command: typeof run = async (args, options) => {
    if (args[0] === 'tar') return run(args, options)
    installs++
    expect(options?.env?.HTTPS_PROXY).toBe(process.env.WORKLING_UPDATE_PROXY)
    expect(options?.env?.HTTP_PROXY).toBe(process.env.WORKLING_UPDATE_PROXY)
    expect(options?.env?.PATH).toBe(process.env.PATH)
    expect(options?.env?.WORKLING_UPDATE_REPO).toBe('a/b')
    return ''
  }
  await startUpdate({ target: 'v0.2.0', ...f.options, command })
  expect((await settled(f.appHome)).status).toBe('done')
  expect(installs).toBe(1)
})

test('drain 等待任务归零后才备份切换退出，waiting 期间暂停拉起', async () => {
  const f = await fixture()
  const issue = await addRunning(f.db)
  const active = await startUpdate({ target: 'v0.2.0', ...f.options, drainIntervalMs: 10 })
  await waiting()
  expect(launchPaused()).toBe(true)
  expect(active.logs.at(-1)).toBe('等待 1 个运行中的任务结束')
  expect(f.calls[1]?.slice(0, 2)).toEqual(['bun', 'install'])
  await Bun.sleep(35)
  expect(active.logs.filter((line) => line.startsWith('等待'))).toHaveLength(1)
  expect(existsSync(join(f.data, 'backups'))).toBe(false)
  expect(existsSync(join(f.appHome, 'current'))).toBe(false)
  expect(readState(f.appHome)).toBeNull()
  expect(f.exits).toEqual([])
  f.db.$client.run("UPDATE sample SET value = 'finished task'")
  f.db.update(issues).set({ status: 'done' }).where(eq(issues.id, issue.id)).run()
  await settled(f.appHome)
  expect(active.status).toBe('done')
  const backup = new Database(readState(f.appHome)!.backup!, { readonly: true })
  try {
    expect(backup.query('SELECT value FROM sample').get()).toEqual({ value: 'finished task' })
  } finally {
    backup.close()
  }
  expect(await readlink(join(f.appHome, 'current'))).toBe(join(f.appHome, 'releases/v0.2.0'))
  expect(f.exits).toEqual([0])
  expect(launchPaused()).toBe(false)
})

test('cancel 接口仅 waiting 成功，清理临时产物、释放锁且允许再次更新', async () => {
  const f = await fixture()
  await addRunning(f.db)
  const request = systemRequest(f)
  const gate = Promise.withResolvers<void>()
  const command: typeof run = async (args, options) => {
    if (args[0] === 'tar') return run(args, options)
    await gate.promise
    return ''
  }
  const active = await startUpdate({ target: 'v0.2.0', ...f.options, command })
  expect(launchPaused()).toBe(true)
  expect((await request('/api/system/job/cancel')).status).toBe(409)
  gate.resolve()
  await waiting()
  const response = await request('/api/system/job/cancel')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ job: { status: 'failed', error: '已取消' } })
  expect(active.error).toBe('已取消')
  expect(launchPaused()).toBe(false)
  for (const file of ['update.lock', 'releases/v0.2.0.partial', 'tmp/v0.2.0.tar.gz', 'current'])
    expect(existsSync(join(f.appHome, file))).toBe(false)
  expect(readState(f.appHome)).toBeNull()
  expect(f.exits).toEqual([])
  expect((await request('/api/system/job/cancel')).status).toBe(409)
  await startUpdate({ target: 'v0.2.0', ...f.options, mode: 'now' })
  expect((await settled(f.appHome)).status).toBe('done')
  expect((await request('/api/system/job/cancel')).status).toBe(409)
})

test('mode=now 有运行中任务仍直接备份切换并退出', async () => {
  const f = await fixture()
  await addRunning(f.db)
  const active = await startUpdate({ target: 'v0.2.0', ...f.options, mode: 'now' })
  await settled(f.appHome)
  expect(active.status).toBe('done')
  expect(active.logs.some((line) => line.startsWith('等待'))).toBe(false)
  expect(existsSync(readState(f.appHome)!.backup!)).toBe(true)
  expect(f.exits).toEqual([0])
})

test('升级保留 lastSuccess，markHealthy 仅在目标版本健康后更新成功记录', async () => {
  const f = await fixture()
  const lastSuccess = { tag: 'v0.1.0', at: '2026-11-14T00:00:00.000Z' }
  writeState(f.appHome, initial({ current: 'v0.1.0', lastSuccess }))
  await startUpdate({ target: 'v0.2.0', ...f.options })
  await settled(f.appHome)
  expect(readState(f.appHome)?.lastSuccess).toEqual(lastSuccess)
  const root = join(f.appHome, 'releases/v0.2.0')
  markHealthy(root)
  const success = readState(f.appHome)!.lastSuccess!
  expect(success.tag).toBe('v0.2.0')
  expect(Date.parse(success.at)).toBeGreaterThanOrEqual(Date.parse(getJob()!.startedAt))
  expect(localVersionInfo(f.db, root).lastSuccess).toEqual(success)
  markHealthy(root)
  expect(readState(f.appHome)?.lastSuccess).toEqual(success)
})

test('渠道与 compare 结果决定目标，禁止非前进更新', async () => {
  const f = await fixture()
  const sha = '0123456789abcdef0123456789abcdef01234567'
  for (const channel of ['stable', 'edge'] as const) {
    updateUpdateChannel(f.db, channel)
    await writeFile(join(f.imageRoot, 'VERSION'), 'edge-aaaaaaaaaaaa')
    for (const status of ['ahead', 'identical', 'behind', 'diverged'] as const) {
      const fetch: UpdateFetch = async (url) =>
        url.includes('/releases?')
          ? Response.json([release('v0.2.0')])
          : url.includes('/commits/')
            ? Response.json({ sha })
            : Response.json({ status })
      const result = await versionInfo({ db: f.db, root: f.imageRoot, fetch })
      const eligible = status === 'ahead' || (channel === 'stable' && status === 'identical')
      expect(result.target?.version ?? null).toBe(
        eligible ? (channel === 'edge' ? `edge-${sha.slice(0, 12)}` : 'v0.2.0') : null,
      )
      expect(result.hasUpdate).toBe(eligible)
      if (status === 'behind' || status === 'diverged') expect(result.note).toBeTruthy()
    }
  }
})

test('edge 更新使用完整 sha 并记录镜像版本，目标变化与契约不兼容均被拒绝', async () => {
  const f = await fixture()
  const sha = '0123456789abcdef0123456789abcdef01234567'
  updateUpdateChannel(f.db, 'edge')
  const archive = await readFile(join(f.dir, 'source.tar.gz'))
  const urls: string[] = []
  const fetch: UpdateFetch = async (url) => {
    urls.push(url)
    if (url.includes('/commits/')) return Response.json({ sha })
    if (url.includes('/compare/')) return Response.json({ status: 'ahead' })
    return new Response(archive)
  }
  await expect(startUpdate({ ...f.options, fetch, target: 'edge-aaaaaaaaaaaa' })).rejects.toThrow(
    '目标版本已变化',
  )
  await startUpdate({ ...f.options, fetch, target: `edge-${sha.slice(0, 12)}` })
  expect((await settled(f.appHome)).status).toBe('done')
  expect(urls.some((url) => url.endsWith(`/tarball/${sha}`))).toBe(true)
  expect(await readFile(join(f.appHome, `releases/edge-${sha.slice(0, 12)}/VERSION`), 'utf8')).toBe(
    `edge-${sha.slice(0, 12)}\n`,
  )
  expect(readState(f.appHome)?.image).toBe('v0.1.0')
  expect((await readdir(join(f.data, 'backups')))[0]).toContain('v0.1.0')
  await writeFile(join(f.imageRoot, 'src/contract/spec.ts'), 'export const CONTRACT_VERSION = 2')
  await startUpdate({ ...f.options, fetch, target: `edge-${sha.slice(0, 12)}` })
  expect((await settled(f.appHome)).error).toContain('任务契约')
  await writeFile(join(f.imageRoot, 'src/contract/spec.ts'), 'export const CONTRACT_VERSION = 1')
  const nextSha = 'fedcba9876543210fedcba9876543210fedcba98'
  const nextFetch: UpdateFetch = async (url) =>
    url.includes('/commits/')
      ? Response.json({ sha: nextSha })
      : url.includes('/compare/')
        ? Response.json({ status: 'ahead' })
        : new Response(archive)
  await startUpdate({
    ...f.options,
    root: join(f.appHome, `releases/edge-${sha.slice(0, 12)}`),
    fetch: nextFetch,
    target: `edge-${nextSha.slice(0, 12)}`,
  })
  expect((await settled(f.appHome)).status).toBe('done')
  expect(
    (await readdir(join(f.data, 'backups'))).some((name) =>
      name.includes(`edge-${sha.slice(0, 12)}`),
    ),
  ).toBe(true)
})

test('下载拒绝非法 ref', async () => {
  const dir = await temp()
  for (const ref of ['main', '../bad', 'A'.repeat(40), 'edge-012345abcdef'])
    await expect(downloadTarball({ repo: 'a/b', ref, dest: join(dir, 'archive') })).rejects.toThrow(
      '非法版本',
    )
})
