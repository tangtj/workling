import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// 在浏览器边界替换 DOM、网络与计时器，验证真实脚本的异步交互。
function browser(local: Record<string, unknown> = {}) {
  class Element {
    hidden = false
    disabled = false
    textContent = ''
    href = ''
    title = ''
    checked = false
    value = 'drain'
    className = ''
    clientHeight = 40
    scrollHeight = 100
    dataset: Record<string, string> = { current: 'v1.0.0' }
    attributes: Record<string, string> = {}
    handlers = new Map<string, () => unknown>()
    classList = { toggle() {}, remove() {} }
    setAttribute(name: string, value: string) {
      this.attributes[name] = value
    }
    removeAttribute() {}
    focus() {
      focused = [...nodes].find(([, node]) => node === this)?.[0]
    }
    contains(target: unknown) {
      return target === this
    }
    addEventListener(name: string, handler: () => unknown) {
      this.handlers.set(name, handler)
    }
    querySelector(selector: string) {
      return get(selector.includes('input') ? 'radio' : 'dot')
    }
    querySelectorAll() {
      return []
    }
  }
  let focused: string | undefined
  const nodes = new Map<string, Element>()
  const get = (id: string): Element => {
    if (!nodes.has(id)) nodes.set(id, new Element())
    return nodes.get(id)!
  }
  get('version-popover').hidden = true
  const events = new Map<string, (event: unknown) => unknown>()
  const timers: Array<{ callback: () => void; ms: number }> = []
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = []
  const info = {
    current: 'v1.0.0',
    mode: 'docker',
    repoConfigured: true,
    releasesUrl: 'https://github.com/a/b/releases',
    runningTasks: 2,
    job: null,
    ...local,
  }
  const latest = { tag: 'v1.1.0', body: '<img src=x onerror=alert(1)>\n一\n二\n三\n四' }
  let job: Record<string, unknown> | null = null
  let reloads = 0
  const destroy = runInNewContext(
    readFileSync('src/web/assets/version.js', 'utf8').replace(
      'export function init()',
      'function init()',
    ) + '\ninit()',
    {
      document: {
        getElementById: get,
        addEventListener: (name: string, fn: (event: unknown) => unknown) => events.set(name, fn),
        removeEventListener: (name: string) => events.delete(name),
        body: { dataset: {} },
      },
      window: {},
      location: { assign() {}, reload: () => reloads++ },
      AbortSignal,
      AbortController,
      setTimeout: (callback: () => void, ms: number) => {
        timers.push({ callback, ms })
        return callback
      },
      clearTimeout: (callback: () => void) => {
        const index = timers.findIndex((timer) => timer.callback === callback)
        if (index !== -1) timers.splice(index, 1)
      },
      fetch: async (path: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ path, body })
        if (path.endsWith('version?local=1')) return Response.json(info)
        if (path.endsWith('/job')) return Response.json(job)
        if (path.endsWith('/update')) {
          job = {
            kind: 'update',
            tag: body.tag,
            status: 'waiting',
            logs: ['1', '2', '3', '4', '5', '6'],
          }
          return Response.json({ job })
        }
        return Response.json({ ...info, hasUpdate: true, latest })
      },
    },
  )
  const flush = () => Bun.sleep(0)
  const click = async (id: string) => {
    await get(`version-${id}`).handlers.get('click')?.()
    await flush()
  }
  const advance = async (ms: number) => {
    const index = timers.findIndex((timer) => timer.ms === ms)
    expect(index).toBeGreaterThanOrEqual(0)
    timers.splice(index, 1)[0]!.callback()
    await flush()
  }
  return {
    get,
    destroy,
    timers,
    calls,
    info,
    click,
    advance,
    flush,
    events,
    setJob: (value: Record<string, unknown>) => {
      job = value
    },
    focused: () => focused,
    reloads: () => reloads,
  }
}

test('版本弹层先读本地再空闲检查，安全显示发布正文并支持强制刷新和关闭焦点', async () => {
  const b = browser()
  await b.flush()
  expect(b.calls.map((call) => call.path)).toEqual(['/api/system/version?local=1'])
  await b.advance(1000)
  expect(b.calls.at(-1)?.path).toBe('/api/system/version')
  expect(b.get('version-pill').title).toBe('发现新版本 v1.1.0')
  await b.click('pill')
  expect(b.get('version-popover').hidden).toBe(false)
  expect(b.get('version-pill').attributes['aria-expanded']).toBe('true')
  expect(b.get('version-notes').textContent).toContain('<img src=x onerror=alert(1)>')
  expect(b.get('version-link').href).toBe('https://github.com/a/b/releases')
  await b.click('check')
  expect(b.calls.at(-1)?.path).toBe('/api/system/version?force=1')
  b.events.get('keydown')?.({ key: 'Escape', preventDefault() {} })
  expect(b.get('version-popover').hidden).toBe(true)
  expect(b.get('version-pill').attributes['aria-expanded']).toBe('false')
  expect(b.focused()).toBe('version-pill')
  await b.click('pill')
  b.events.get('click')?.({ target: {} })
  expect(b.get('version-popover').hidden).toBe(true)
})

test('更新先确认并默认等待任务，失败显示最近五行日志并可返回', async () => {
  const b = browser()
  await b.flush()
  await b.advance(1000)
  await b.click('update')
  expect(b.get('version-confirmation').hidden).toBe(false)
  expect(b.get('version-drain-label').textContent).toContain('2 个运行中任务')
  expect(b.get('radio').checked).toBe(true)
  expect(b.calls.some((call) => call.path.endsWith('/update'))).toBe(false)
  await b.click('confirm')
  expect(b.calls.at(-1)).toEqual({
    path: '/api/system/update',
    body: { tag: 'v1.1.0', mode: 'drain' },
  })
  expect(b.get('version-status').textContent).toBe('等待任务结束…')
  expect(b.get('version-logs').textContent).toBe('2\n3\n4\n5\n6')
  b.setJob({ status: 'failed', logs: ['依赖安装失败'], error: '更新失败' })
  await b.advance(1500)
  expect(b.get('version-status').textContent).toBe('更新失败')
  expect(b.get('version-back').hidden).toBe(false)
  await b.click('back')
  expect(b.get('version-progress').hidden).toBe(true)
})

test('开发版本仅展示发布信息，不提供更新按钮或更新提示圆点', async () => {
  const b = browser({ current: 'dev' })
  await b.flush()
  await b.advance(1000)
  expect(b.get('version-description').textContent).toBe('开发版本，不参与版本比较')
  expect(b.get('version-update').hidden).toBe(true)
  expect(b.get('dot').hidden).toBe(true)
})

test('已有运行作业时自动打开弹层并恢复进度', async () => {
  const b = browser({
    job: { status: 'running', kind: 'update', tag: 'v1.1.0', logs: ['正在安装'] },
  })
  await b.flush()
  expect(b.get('version-popover').hidden).toBe(false)
  expect(b.get('version-status').textContent).toBe('正在执行…')
  expect(b.get('version-logs').textContent).toBe('正在安装')
  expect(b.calls).toHaveLength(1)
})

test('版本面板销毁移除全局监听并取消待执行检查', async () => {
  const b = browser()
  await b.flush()
  expect(b.events.size).toBe(2)
  expect(b.timers.length).toBe(1)
  b.destroy()
  await b.flush()
  expect(b.events.size).toBe(0)
  expect(b.timers.length).toBe(0)
  expect(b.calls).toHaveLength(1)
})
