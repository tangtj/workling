import * as Value from 'typebox/value'
import { issueListSchema } from '../issue-list.ts'
import { readResponse } from './http.ts'

export const issueListOptions = {
  queryKey: ['issue-list'],
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const response = await readResponse('/api/issue-list', { signal })
    if (!response.ok) throw new Error('加载页面失败')
    const body: unknown = await response.json()
    if (!Value.Check(issueListSchema, body)) throw new Error('任务列表数据无效')
    return {
      ...body,
      now: new Date(body.now).getTime(),
      issues: body.issues.map((i) => ({
        ...i,
        updatedAt: new Date(i.updatedAt),
        lastRun: i.lastRun && {
          ...i.lastRun,
          startedAt: new Date(i.lastRun.startedAt),
          endedAt: i.lastRun.endedAt ? new Date(i.lastRun.endedAt) : null,
        },
      })),
    }
  },
  retry: false as const,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false as const,
}
export type IssueList = Awaited<ReturnType<typeof issueListOptions.queryFn>>
