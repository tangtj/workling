import { open, rm } from 'node:fs/promises'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { compareVersions, validTag, isPrerelease } from '../runtime/version.ts'

export type UpdateFetch = (
  url: string,
  init?: RequestInit & { proxy?: string },
) => Promise<Response>
export type Release = { tag: string; name: string; publishedAt: string; body: string; url: string }
const releaseSchema = Type.Array(
  Type.Object({
    tag_name: Type.String(),
    name: Type.Union([Type.String(), Type.Null()]),
    published_at: Type.Union([Type.String(), Type.Null()]),
    body: Type.Union([Type.String(), Type.Null()]),
    html_url: Type.String(),
    draft: Type.Boolean(),
    prerelease: Type.Boolean(),
  }),
)
// 缓存按 fetch 边界隔离，凭证只用于缓存身份，不进入响应与日志。
const caches = new WeakMap<UpdateFetch, Map<string, { at: number; releases: Release[] }>>()
const headers = (token: string) => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'workling',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})
export function repoPath(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error('WORKLING_UPDATE_REPO 格式必须为 owner/repo')
  return repo.split('/').map(encodeURIComponent).join('/')
}

export async function listReleases({
  repo,
  token = '',
  proxy = process.env.WORKLING_UPDATE_PROXY,
  fetch: request = globalThis.fetch,
  force = false,
  now = Date.now,
}: {
  repo: string
  token?: string
  proxy?: string
  fetch?: UpdateFetch
  force?: boolean
  now?: () => number
}): Promise<Release[]> {
  const path = repoPath(repo)
  let cache = caches.get(request)
  if (!cache) {
    cache = new Map()
    caches.set(request, cache)
  }
  const key = JSON.stringify([repo, token, proxy])
  const hit = cache.get(key)
  if (!force && hit && now() - hit.at < 20 * 60_000) return hit.releases
  let response: Response
  try {
    response = await request(`https://api.github.com/repos/${path}/releases?per_page=20`, {
      headers: headers(token),
      proxy,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error('GitHub Release 请求失败')
  }
  if (!response.ok) throw new Error(`GitHub Release 请求失败（HTTP ${response.status}）`)
  const input: unknown = await response.json()
  if (!Value.Check(releaseSchema, input)) throw new Error('GitHub Release 响应格式无效')
  const releases = input
    .filter(
      (item) =>
        !item.draft && !item.prerelease && validTag(item.tag_name) && !isPrerelease(item.tag_name),
    )
    .map((item) => ({
      tag: item.tag_name,
      name: item.name ?? item.tag_name,
      publishedAt: item.published_at ?? '',
      body: (item.body ?? '').slice(0, 2000),
      url: item.html_url,
    }))
    .sort((a, b) => compareVersions(b.tag, a.tag))
  cache.set(key, { at: now(), releases })
  return releases
}

export async function downloadTarball({
  repo,
  tag,
  token = '',
  dest,
  proxy = process.env.WORKLING_UPDATE_PROXY,
  fetch: request = globalThis.fetch,
}: {
  repo: string
  tag: string
  token?: string
  dest: string
  proxy?: string
  fetch?: UpdateFetch
}): Promise<void> {
  if (!validTag(tag)) throw new Error('非法 tag')
  let url = new URL(
    `https://api.github.com/repos/${repoPath(repo)}/tarball/${encodeURIComponent(tag)}`,
  )
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  const limit = 50 * 1024 * 1024
  try {
    for (let redirects = 0; ; redirects++) {
      if (
        url.protocol !== 'https:' ||
        !['api.github.com', 'codeload.github.com'].includes(url.hostname) ||
        url.port ||
        url.username ||
        url.password
      )
        throw new Error('下载重定向地址不在允许范围内')
      let response: Response
      try {
        response = await request(url.href, {
          headers: headers(url.hostname === 'api.github.com' ? token : ''),
          proxy,
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch {
        throw new Error('版本下载失败')
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || redirects >= 3) throw new Error('下载重定向次数过多或缺少地址')
        url = new URL(location, url)
        continue
      }
      if (!response.ok || !response.body) throw new Error(`版本下载失败（HTTP ${response.status}）`)
      if (Number(response.headers.get('content-length')) > limit) {
        controller.abort()
        await response.body.cancel()
        throw new Error('下载超过 50 MB')
      }
      const file = await open(dest, 'w', 0o600)
      const reader = response.body.getReader()
      try {
        let size = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > limit) {
            controller.abort()
            throw new Error('下载超过 50 MB')
          }
          await file.writeFile(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        await file.close()
      }
      return
    }
  } catch (error) {
    await rm(dest, { force: true })
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
