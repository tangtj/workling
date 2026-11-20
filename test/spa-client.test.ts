import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

test('会话过期的请求跳转登录', async () => {
  const redirects: string[] = []
  const source = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(readFileSync('src/web/client/http.ts', 'utf8'))
    .replace(/^export /gm, '')
  const readResponse = runInNewContext(`${source}\nreadResponse`, {
    URL,
    location: { assign: (url: string) => redirects.push(url) },
    fetch: async () => Response.json({ error: '未登录' }, { status: 401 }),
  })
  await expect(readResponse('/api/shell')).rejects.toThrow('未登录')
  expect(redirects).toEqual(['/login'])
})
