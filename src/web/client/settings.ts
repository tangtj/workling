import * as Value from 'typebox/value'
import { settingsSchema, type SettingsData } from '../settings.ts'
import { readResponse } from './http.ts'

export const settingsOptions = {
  queryKey: ['settings'],
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const response = await readResponse('/api/settings', { signal })
    if (!response.ok) throw new Error('加载页面失败')
    const body: unknown = await response.json()
    if (!Value.Check(settingsSchema, body)) throw new Error('设置数据无效')
    return body
  },
  retry: false as const,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false as const,
}
export type Card = 'codex' | 'pi' | 'git' | 'executor'
export type Draft = Record<string, string>
export function cardDraft(data: SettingsData, card: Card): Draft {
  const p = data.pi,
    e = data.executor
  switch (card) {
    case 'codex':
      return { model: p.model, effort: p.effort }
    case 'pi':
      return {
        piModel: p.piModel ?? '',
        llmApi: p.llmApi,
        llmBaseUrl: p.llmBaseUrl ?? '',
        llmApiKey: '',
      }
    case 'git':
      return { gitName: p.gitName, gitEmail: p.gitEmail }
    case 'executor':
      return {
        sandbox: e.sandbox,
        concurrency: String(e.concurrency),
        taskImage: e.taskImage,
        taskCpus: String(e.taskCpus),
        taskMemory: e.taskMemory,
        taskPids: String(e.taskPids),
        taskNetwork: e.taskNetwork ?? '',
      }
  }
}
export function cardBody(card: Card, draft: Draft): Record<string, string | number | null> {
  const body: Record<string, string | number | null> = { ...draft }
  if (card === 'pi') {
    body.piModel = draft.piModel || null
    body.llmBaseUrl = draft.llmBaseUrl || null
    if (!draft.llmApiKey) delete body.llmApiKey
  }
  if (card === 'executor') {
    for (const field of ['concurrency', 'taskCpus', 'taskPids']) body[field] = Number(draft[field])
    body.taskNetwork = draft.taskNetwork || null
  }
  return body
}
export function isDirty(baseline: Draft, draft: Draft) {
  return JSON.stringify(baseline) !== JSON.stringify(draft)
}
export function syncDraft(baseline: Draft, draft: Draft, next: Draft, saved: boolean): Draft {
  return saved || !isDirty(baseline, draft) ? next : draft
}
