import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { themeScript } from '../src/web/views/theme.ts'

test('首屏按有效主题偏好设置属性，缺省、非法值和读取失败时跟随系统', () => {
  for (const [stored, expected] of [
    [null, undefined],
    ['invalid', undefined],
    ['system', undefined],
    ['light', 'light'],
    ['dark', 'dark'],
  ] as Array<[string | null, string | undefined]>) {
    let theme: string | undefined
    const style = { colorScheme: '' }
    runInNewContext(themeScript, {
      localStorage: { getItem: () => stored },
      document: {
        documentElement: { style, setAttribute: (_: string, value: string) => (theme = value) },
      },
    })
    expect(theme).toBe(expected)
    expect(style.colorScheme).toBe(expected ?? '')
  }
  expect(() =>
    runInNewContext(themeScript, {
      localStorage: {
        getItem: () => {
          throw new Error('unavailable')
        },
      },
    }),
  ).not.toThrow()
})
