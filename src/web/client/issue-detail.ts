import * as Value from 'typebox/value'
import { issueDetailSchema } from '../issue-detail.ts'
import { readResponse } from './http.ts'

export function parseDetailId(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : undefined
}

export function runDetailOptions(runId: number | undefined) {
  return detailOptions('run-detail', 'runs', runId)
}

export function issueDetailOptions(issueId: number | undefined) {
  return detailOptions('issue-detail', 'issues', issueId)
}

function detailOptions(key: string, resource: 'issues' | 'runs', id: number | undefined) {
  return {
    queryKey: [key, id],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (id === undefined) return null
      const response = await readResponse(`/api/${resource}/${id}/detail`, { signal })
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
        triage: body.triage,
        rework: body.rework,
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
