import * as Value from 'typebox/value'
import { feedbackSchema, trustedUsersSchema } from '../feedback.ts'
import { readResponse } from './http.ts'

export async function loadFeedback(id: number, signal: AbortSignal) {
  const response = await readResponse(`/api/issues/${id}/feedback`, { signal })
  if (!response.ok) throw new Error('加载反馈失败')
  const data: unknown = await response.json()
  if (!Value.Check(feedbackSchema, data)) throw new Error('反馈数据无效')
  return data
}
export async function loadTrustedUsers(id: number, signal: AbortSignal) {
  const response = await readResponse(`/api/repos/${id}/trusted-users`, { signal })
  if (!response.ok) throw new Error('加载受信账号失败')
  const data: unknown = await response.json()
  if (!Value.Check(trustedUsersSchema, data)) throw new Error('受信账号数据无效')
  return data
}
