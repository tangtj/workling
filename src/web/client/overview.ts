import * as Value from 'typebox/value'
import { overviewSchema } from '../overview.ts'
import { readResponse } from './http.ts'

export const overviewOptions = {
  queryKey: ['overview'],
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const response = await readResponse('/api/overview', { signal })
    if (!response.ok) throw new Error('加载页面失败')
    const body: unknown = await response.json()
    if (!Value.Check(overviewSchema, body)) throw new Error('概览数据无效')
    const run = (r: NonNullable<(typeof body.issues)[number]['lastRun']>) => ({
      ...r,
      startedAt: new Date(r.startedAt),
      endedAt: r.endedAt ? new Date(r.endedAt) : null,
    })
    return {
      ...body,
      now: new Date(body.now).getTime(),
      watch: body.watch && {
        ...body.watch,
        lastPollAt: body.watch.lastPollAt ? new Date(body.watch.lastPollAt) : null,
      },
      issues: body.issues.map((i) => ({
        ...i,
        updatedAt: new Date(i.updatedAt),
        lastRun: i.lastRun && run(i.lastRun),
        runs: i.runs.map(run),
      })),
    }
  },
  retry: false as const,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false as const,
}
