import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function client(fetch: (path: string, init?: RequestInit) => Promise<Response> = globalThis.fetch) {
  const redirects: string[] = []
  class Element {
    closest() {
      return this
    }
  }
  class Anchor extends Element {
    target = ''
    download = false
    constructor(readonly href: string) {
      super()
    }
    getAttribute() {
      return this.href
    }
    hasAttribute() {
      return this.download
    }
  }
  const source = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(readFileSync('src/web/client/legacy.ts', 'utf8'))
    .replace(/^export /gm, '')
  const helpers = runInNewContext(`${source}\n({ internalLink, fragmentOptions, readResponse })`, {
    Element,
    HTMLAnchorElement: Anchor,
    URL,
    Number,
    location: {
      href: 'http://localhost/settings',
      origin: 'http://localhost',
      assign: (url: string) => redirects.push(url),
    },
    fetch,
  })
  return { helpers, redirects, Anchor }
}

test('片段内只拦截可由路由处理的同源链接，保留下载、新窗口、API 和修饰键行为', () => {
  const { helpers, Anchor } = client()
  const root = { contains: () => true }
  const event = (target: unknown) => ({ target, button: 0 })
  for (const [href, expected] of [
    ['/issues?repo=1', '/issues?repo=1'],
    ['/repos#add', '/repos#add'],
    ['#set-password', '/settings#set-password'],
    ['/api/runs/1/log', undefined],
    ['//external.example/issues', undefined],
    ['https://external.example/issues', undefined],
    ['/login', undefined],
  ])
    expect(helpers.internalLink(event(new Anchor(href!)), root)).toBe(expected)
  for (const option of ['ctrlKey', 'shiftKey', 'metaKey', 'altKey', 'defaultPrevented'])
    expect(
      helpers.internalLink({ ...event(new Anchor('/issues')), [option]: true }, root),
    ).toBeUndefined()
  const link = new Anchor('/issues')
  link.target = '_blank'
  expect(helpers.internalLink(event(link), root)).toBeUndefined()
  link.target = ''
  link.download = true
  expect(helpers.internalLink(event(link), root)).toBeUndefined()
  expect(helpers.internalLink({ ...event(new Anchor('/issues')), button: 1 }, root)).toBeUndefined()
})

test('片段获取携带标记和取消信号，404 HTML 仍显示，并读取编码标题和刷新间隔', async () => {
  let requested: { path: unknown; init?: RequestInit } | undefined
  const { helpers } = client(async (path, init) => {
    requested = { path, init }
    return new Response('<section>不存在</section>', {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Workling-Title': encodeURIComponent('页面不存在'),
        'X-Workling-Active': '',
        'X-Workling-Refresh': '',
      },
    })
  })
  const options = helpers.fragmentOptions('/issues/999?q=a')
  expect(options.queryKey).toEqual(['fragment', '/issues/999?q=a'])
  const signal = new AbortController().signal
  expect(await options.queryFn({ signal })).toEqual({
    html: '<section>不存在</section>',
    title: '页面不存在',
    active: '',
    refresh: 0,
  })
  expect(requested?.path).toBe('/issues/999?q=a')
  expect(requested?.init?.signal).toBe(signal)
  expect(requested?.init?.headers).toEqual({ 'X-Workling-Fragment': '1' })
})

test('片段 JSON 错误不会插入页面，会话过期时跳转登录，网络错误交给重试界面', async () => {
  const json = client(async () => Response.json({ error: '失败' }, { status: 500 }))
  await expect(
    json.helpers.fragmentOptions('/issues').queryFn({ signal: new AbortController().signal }),
  ).rejects.toThrow('加载页面失败')
  const unauthenticated = client(async () => Response.json({ error: '未登录' }, { status: 401 }))
  await expect(unauthenticated.helpers.readResponse('/api/shell')).rejects.toThrow('未登录')
  expect(unauthenticated.redirects).toEqual(['/login'])
  const offline = client(async () => {
    throw new Error('offline')
  })
  await expect(
    offline.helpers.fragmentOptions('/issues').queryFn({ signal: new AbortController().signal }),
  ).rejects.toThrow('offline')
})
