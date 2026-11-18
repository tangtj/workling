import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function moduleCode(name: string) {
  return (
    readFileSync(`src/web/assets/${name}.js`, 'utf8')
      .replace(/^import \{[\s\S]*?\} from '\/timeline.js'\n/, '')
      .replace('export function init(', 'function init(') + '\ninit'
  )
}

test('旧页面脚本重复挂载只保留一次监听，卸载关闭对话框并清除复制提示计时器', async () => {
  const copy = new EventTarget()
  Object.assign(copy, { dataset: { copy: 'copied text' }, textContent: '复制' })
  const dialog = { close: () => closed++ }
  let closed = 0
  let copies = 0
  const timers = new Set<() => void>()
  const root = {
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === '[data-copy]' ? [copy] : selector === 'dialog[open]' ? [dialog] : [],
  }
  const init = runInNewContext(moduleCode('app'), {
    AbortController,
    location: { hash: '' },
    navigator: {
      clipboard: {
        writeText: async () => {
          copies++
        },
      },
    },
    setTimeout: (callback: () => void) => {
      timers.add(callback)
      return callback
    },
    clearTimeout: (callback: () => void) => timers.delete(callback),
  })
  const ctx = { navigate() {}, refresh() {} }
  const destroy = init(root, ctx)
  copy.dispatchEvent(new Event('click'))
  await Bun.sleep(0)
  expect(copies).toBe(1)
  expect(timers.size).toBe(1)
  destroy()
  expect(closed).toBe(1)
  expect(timers.size).toBe(0)
  const destroyAgain = init(root, ctx)
  copy.dispatchEvent(new Event('click'))
  await Bun.sleep(0)
  expect(copies).toBe(2)
  destroyAgain()
})

test('时间线初始化只在挂载时发请求，卸载中止请求并释放轮询计时器', async () => {
  const intervals = new Set<() => void>()
  let signal: AbortSignal | undefined
  let requests = 0
  const timeline = {
    classList: { contains: () => true },
    dataset: { runId: '1', ended: 'false' },
    closest: () => null,
    append() {},
    querySelectorAll: () => [],
  }
  const init = runInNewContext(moduleCode('run-log'), {
    AbortController,
    DOMException,
    document: {
      createElement: () => ({ dataset: {}, setAttribute() {}, append() {}, remove() {} }),
    },
    createTimeline: () => ({ items: [] }),
    TextDecoder,
    setInterval: (callback: () => void) => {
      intervals.add(callback)
      return callback
    },
    clearInterval: (callback: () => void) => intervals.delete(callback),
    fetch: (_path: string, options: RequestInit) => {
      requests++
      signal = options.signal!
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      )
    },
  })
  expect(requests).toBe(0)
  const root = { querySelector: () => null, querySelectorAll: () => [timeline] }
  const destroy = init(root)
  expect(requests).toBe(1)
  expect(intervals.size).toBe(1)
  destroy()
  await Bun.sleep(0)
  expect(signal!.aborted).toBe(true)
  expect(intervals.size).toBe(0)
})
