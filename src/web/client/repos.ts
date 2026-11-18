import * as Value from 'typebox/value'
import { reposSchema } from '../repos.ts'
import { readResponse } from './legacy.ts'

export async function repoRequest(path: string, method: string, body?: unknown) {
  const response = await readResponse(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null)
    throw new Error(
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : '操作失败',
    )
  }
  return response.status === 204 ? null : response.json()
}

export const reposOptions = {
  queryKey: ['repos'],
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const response = await readResponse('/api/repos', { signal })
    if (!response.ok) throw new Error('加载页面失败')
    const body: unknown = await response.json()
    if (!Value.Check(reposSchema, body)) throw new Error('仓库数据无效')
    return body.map((repo) => ({
      ...repo,
      createdAt: new Date(repo.createdAt),
      updatedAt: new Date(repo.updatedAt),
    }))
  },
  retry: false as const,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false as const,
}
