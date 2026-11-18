import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIssue } from '../src/issue/read.ts'
import { createTaskDir } from '../src/task/dir.ts'
import { parseIssueRef } from '../src/issue/reference.ts'
import type { Command } from '../src/runtime/types.ts'

const ref = parseIssueRef('github:a/b#12')
const issue = {
  number: 12,
  title: '标题',
  body: '正文',
  state: 'OPEN',
  url: 'https://github.com/a/b/issues/12',
  author: { login: '作者' },
  labels: [],
  createdAt: '2026-01-01',
  comments: [] as { author: { login: string }; body: string; createdAt: string }[],
}

async function withDir(action: (input: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'workling-read-'))
  try {
    await action(join(dir, 'input'), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('形状错误和非 GitHub 引用被拒绝', async () =>
  withDir(async (dir) => {
    await expect(readIssue({ ref, dir, command: async () => '{}', env: {} })).rejects.toThrow(
      'Issue 格式无效',
    )
    await expect(
      readIssue({ ref: parseIssueRef('gitlab:a/b#1'), dir, command: async () => '', env: {} }),
    ).rejects.toThrow('read 目前只支持 GitHub')
  }))

test('评论按时间排序并完整渲染无标签和附件的 issue.md，保留原始 JSON', async () =>
  withDir(async (dir) => {
    const raw =
      JSON.stringify({
        ...issue,
        comments: [
          { author: { login: '后' }, body: '第二条', createdAt: '2026-02-02' },
          { author: { login: '先' }, body: '第一条', createdAt: '2026-02-01' },
        ],
      }) + '\n'
    const command: Command = async (args, options) => {
      expect(args).toEqual([
        'gh',
        'issue',
        'view',
        '12',
        '-R',
        'a/b',
        '--json',
        'number,title,body,state,url,author,labels,createdAt,comments',
      ])
      expect(options?.env).toEqual({
        GH_TOKEN: 'secret',
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
      })
      return raw
    }
    const { path, title, body } = await readIssue({
      ref,
      dir,
      command,
      env: { GH_TOKEN: 'secret' },
    })
    expect(path).toBe(join(dir, 'issue.md'))
    expect(title).toBe('标题')
    expect(body).toBe('正文')
    expect(await readFile(join(dir, 'issue.json'), 'utf8')).toBe(raw)
    expect(await readFile(path, 'utf8')).toBe(
      '# 标题\n\n- 链接：https://github.com/a/b/issues/12\n- 状态：OPEN\n- 作者：作者\n- 标签：无\n- 创建时间：2026-01-01\n\n## 正文\n\n正文\n\n## 评论\n\n### 先 · 2026-02-01\n\n第一条\n\n### 后 · 2026-02-02\n\n第二条\n\n## 附件\n\n无\n',
    )
  }))

test('两个标签按顺序渲染到 issue.md', async () =>
  withDir(async (dir) => {
    const { path } = await readIssue({
      ref,
      dir,
      command: async () =>
        JSON.stringify({ ...issue, labels: [{ name: 'bug' }, { name: 'workling:ready' }] }),
      env: {},
    })
    expect(await readFile(path, 'utf8')).toContain('- 标签：bug、workling:ready')
  }))

test('提取两类附件、去重与清理结尾，按响应及 URL 命名并处理下载失败', async () =>
  withDir(async (dir) => {
    const urls = [
      'https://github.com/user-attachments/assets/one',
      'https://github.com/a/b/assets/two',
      'https://github.com/user-attachments/files/a%3Ab.png',
      'https://github.com/user-attachments/assets/fail',
      'https://github.com/user-attachments/assets/timeout',
      'https://github.com/user-attachments/assets/large',
      'https://github.com/user-attachments/assets/actual',
      'https://github.com/user-attachments/assets/ok',
    ]
    const body = `(${urls[0]}), "${urls[1]}" ${urls[2]}. ${urls[0]} ${urls.slice(3).join(' ')} https://github.com/a/b/issues/1`
    const calls: string[] = []
    const fake: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input)
        calls.push(url)
        expect(init?.redirect).toBe('follow')
        expect(init?.headers).toEqual({ Authorization: 'token secret' })
        if (url === urls[3]) return new Response('', { status: 404 })
        if (url === urls[4]) throw new Error('超时')
        if (url === urls[5])
          return new Response('', { headers: { 'Content-Length': String(50 * 1024 * 1024 + 1) } })
        if (url === urls[6]) return new Response(new Uint8Array(50 * 1024 * 1024 + 1))
        return new Response('x', {
          headers:
            url === urls[0]
              ? {
                  'Content-Disposition': "attachment; filename=ignored; filename*=UTF-8''a%3Ab.png",
                }
              : url === urls[1]
                ? { 'Content-Disposition': 'attachment; filename="a:b.png"' }
                : {},
        })
      },
      { preconnect: fetch.preconnect },
    )
    const { path } = await readIssue({
      ref,
      dir,
      command: async () => JSON.stringify({ ...issue, body }),
      env: { GH_TOKEN: 'secret' },
      fetch: fake,
    })
    expect(calls).toEqual(urls)
    expect(await readFile(path, 'utf8')).toBe(
      `# 标题\n\n- 链接：https://github.com/a/b/issues/12\n- 状态：OPEN\n- 作者：作者\n- 标签：无\n- 创建时间：2026-01-01\n\n## 正文\n\n${body}\n\n## 评论\n\n无\n\n## 附件\n\n- ${urls[0]} → attachments/a_b.png\n- ${urls[1]} → attachments/a_b-2.png\n- ${urls[2]} → attachments/a_b-3.png\n- ${urls[3]} → 下载失败：HTTP 404\n- ${urls[4]} → 下载失败：超时\n- ${urls[5]} → 下载失败：超过 50 MB\n- ${urls[6]} → 下载失败：超过 50 MB\n- ${urls[7]} → attachments/ok\n`,
    )
  }))

test('文件名清理控制字符与开头的点，超长截断保留扩展名，空名回退为 attachment', async () =>
  withDir(async (dir) => {
    const urls = ['p1', 'p2', 'p3', 'p4'].map(
      (name) => `https://github.com/user-attachments/assets/${name}`,
    )
    const names = ['a\u0001b.txt', '..hidden', `${'x'.repeat(120)}.png`, '...']
    const body = urls.join(' ')
    const { path } = await readIssue({
      ref,
      dir,
      command: async () => JSON.stringify({ ...issue, body }),
      env: {},
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const index = urls.indexOf(String(input))
          return new Response('data', {
            headers: { 'Content-Disposition': `attachment; filename="${names[index]}"` },
          })
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const expected = ['a_b.txt', 'hidden', `${'x'.repeat(96)}.png`, 'attachment']
    const markdown = await readFile(path, 'utf8')
    for (const [index, name] of expected.entries()) {
      expect(markdown).toContain(`- ${urls[index]} → attachments/${name}`)
      expect(await readFile(join(dir, 'attachments', name), 'utf8')).toBe('data')
    }
    expect(expected[2]!.length).toBe(100)
  }))

test('链接在方括号、单引号、尖括号处结束', async () =>
  withDir(async (dir) => {
    const urls = ['p1', 'p2', 'p3', 'p4'].map(
      (name) => `https://github.com/user-attachments/assets/${name}`,
    )
    const body = `![图](${urls[0]}]x '${urls[1]}' <${urls[2]}> ${urls[3]},`
    const found: string[] = []
    const { path } = await readIssue({
      ref,
      dir,
      command: async () => JSON.stringify({ ...issue, body }),
      env: {},
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          found.push(String(input))
          return new Response('data')
        },
        { preconnect: fetch.preconnect },
      ),
    })
    expect(found).toEqual(urls)
    const markdown = await readFile(path, 'utf8')
    for (const url of urls) expect(markdown).toContain(`- ${url} → attachments/`)
  }))

test('GH_TOKEN 为空时下载不带 Authorization 头', async () =>
  withDir(async (dir) => {
    const url = 'https://github.com/user-attachments/assets/no-token'
    const { path } = await readIssue({
      ref,
      dir,
      command: async () => JSON.stringify({ ...issue, body: url }),
      env: {},
      fetch: Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          expect(init?.headers).toEqual({})
          return new Response('data')
        },
        { preconnect: fetch.preconnect },
      ),
    })
    expect(await readFile(path, 'utf8')).toContain(`- ${url} → attachments/no-token`)
  }))

test('默认任务目录使用 UTC 时间、权限 0700 且拒绝重名', async () =>
  withDir(async (_input, dir) => {
    const now = new Date('2026-11-14T10:30:00Z')
    const path = await createTaskDir(dir, ref, now)
    expect(path).toBe(join(dir, 'tasks/a-b-12-20261114T103000Z'))
    expect((await stat(path)).mode & 0o777).toBe(0o700)
    await expect(createTaskDir(dir, ref, now)).rejects.toThrow()
  }))
