import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import type { Command, Environment } from '../runtime/types.ts'
import type { IssueRef } from './reference.ts'

const issueSchema = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  body: Type.String(),
  state: Type.String(),
  url: Type.String(),
  createdAt: Type.String(),
  author: Type.Object({ login: Type.String() }),
  labels: Type.Array(Type.Object({ name: Type.String() })),
  comments: Type.Array(
    Type.Object({
      author: Type.Object({ login: Type.String() }),
      body: Type.String(),
      createdAt: Type.String(),
    }),
  ),
})
const limit = 50 * 1024 * 1024

function filename(response: Response, url: string): string {
  const disposition = response.headers.get('content-disposition') ?? ''
  const extended = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition)
  const ordinary = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition)
  let name = (extended?.[1] ?? extended?.[2] ?? ordinary?.[1] ?? ordinary?.[2])?.trim()
  if (extended && name !== undefined) name = name.replace(/^[^']*'[^']*'/, '')
  if (name === undefined) name = new URL(url).pathname.split('/').pop() ?? ''
  if (extended || !ordinary) {
    try {
      name = decodeURIComponent(name)
    } catch {
      /* 保留无法解码的原文 */
    }
  }
  // 附件名称不能包含控制字符。
  // oxlint-disable-next-line no-control-regex
  name = name.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '')
  if (!name) return 'attachment'
  if (name.length > 100) {
    const ext = extname(name).slice(0, 99)
    name = name.slice(0, 100 - ext.length) + ext
  }
  return name
}

export async function readIssue(options: {
  ref: IssueRef
  dir: string
  command: Command
  env: Environment
  fetch?: typeof fetch
}): Promise<{ path: string; title: string; body: string }> {
  const { ref, command, env } = options
  if (ref.platform !== 'github') throw new Error('read 目前只支持 GitHub')
  const dir = resolve(options.dir)
  const raw = await command(
    [
      'gh',
      'issue',
      'view',
      String(ref.iid),
      '-R',
      ref.project,
      '--json',
      'number,title,body,state,url,author,labels,createdAt,comments',
    ],
    { env: { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } },
  )
  const issue: unknown = JSON.parse(raw)
  if (!Value.Check(issueSchema, issue)) throw new Error('Issue 格式无效')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'issue.json'), raw)
  const comments = [...issue.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const urls = new Set<string>()
  const pattern =
    /https:\/\/github\.com\/(?:user-attachments\/(?:assets|files)|[\w.-]+\/[\w.-]+\/assets)\/[^\s)\]"'>]+/g
  for (const body of [issue.body, ...comments.map((comment) => comment.body)]) {
    for (const match of body.matchAll(pattern)) {
      const url = match[0].replace(/[.,]+$/, '')
      if (!url.endsWith('/')) urls.add(url)
    }
  }
  const lines: string[] = []
  const names = new Set<string>()
  if (urls.size) await mkdir(join(dir, 'attachments'), { recursive: true, mode: 0o700 })
  for (const url of urls) {
    try {
      const response = await (options.fetch ?? fetch)(url, {
        headers: env.GH_TOKEN ? { Authorization: `token ${env.GH_TOKEN}` } : {},
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (Number(response.headers.get('content-length')) > limit) throw new Error('超过 50 MB')
      const chunks: Uint8Array[] = []
      let size = 0
      if (response.body) {
        const reader = response.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > limit) {
              await reader.cancel()
              throw new Error('超过 50 MB')
            }
            chunks.push(value)
          }
        } finally {
          reader.releaseLock()
        }
      }
      const base = filename(response, url)
      const ext = extname(base)
      const stem = base.slice(0, base.length - ext.length)
      let name = base
      for (let n = 2; names.has(name); n++)
        name = `${stem.slice(0, 100 - ext.length - String(n).length - 1)}-${n}${ext}`
      await writeFile(join(dir, 'attachments', name), Buffer.concat(chunks))
      names.add(name)
      lines.push(`- ${url} → attachments/${name}`)
    } catch (error) {
      lines.push(`- ${url} → 下载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const commentText = comments.length
    ? comments
        .map((comment) => `### ${comment.author.login} · ${comment.createdAt}\n\n${comment.body}`)
        .join('\n\n')
    : '无'
  const markdown = `# ${issue.title}\n\n- 链接：${issue.url}\n- 状态：${issue.state}\n- 作者：${issue.author.login}\n- 标签：${issue.labels.map((label) => label.name).join('、') || '无'}\n- 创建时间：${issue.createdAt}\n\n## 正文\n\n${issue.body}\n\n## 评论\n\n${commentText}\n\n## 附件\n\n${lines.join('\n') || '无'}\n`
  const path = join(dir, 'issue.md')
  await writeFile(path, markdown)
  return { path, title: issue.title, body: issue.body }
}
