import * as Value from 'typebox/value'
import { issueDetailSchema } from '../issue-detail.ts'
import { readResponse } from './legacy.ts'

export function parseRunId(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : undefined
}

export function runDetailOptions(runId: number | undefined) {
  return {
    queryKey: ['run-detail', runId],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (runId === undefined) return null
      const response = await readResponse(`/api/runs/${runId}/detail`, { signal })
      if (response.status === 404) return null
      if (!response.ok) throw new Error('加载页面失败')
      const body: unknown = await response.json()
      if (!Value.Check(issueDetailSchema, body)) throw new Error('Issue 详情数据无效')
      return {
        now: new Date(body.now).getTime(),
        issue: {
          ...body.issue,
          createdAt: new Date(body.issue.createdAt),
          updatedAt: new Date(body.issue.updatedAt),
        },
        runs: body.runs.map((run) => ({
          ...run,
          startedAt: new Date(run.startedAt),
          endedAt: run.endedAt === null ? null : new Date(run.endedAt),
        })),
      }
    },
    retry: false as const,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false as const,
  }
}
