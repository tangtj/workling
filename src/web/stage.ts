export type Stage =
  | 'queued'
  | 'running'
  | 'rework'
  | 'review'
  | 'capped'
  | 'failed'
  | 'done'
  | 'canceled'

export const stageLabels: Record<Stage, string> = {
  queued: '排队',
  running: '执行中',
  rework: '返工中',
  review: 'PR 待审',
  capped: '返工到上限',
  failed: '失败',
  done: '完成',
  canceled: '已取消',
}
export const attentionStages: Stage[] = ['failed', 'capped']

export function issueStage(input: {
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  prState: 'open' | 'merged' | 'closed' | null
  lastRun: { kind: 'implement' | 'rework'; endedAt: Date | null } | null
  cappedFeedbackAt: Date[]
}): Stage {
  if (input.status === 'running') return input.lastRun?.kind === 'rework' ? 'rework' : 'running'
  if (input.status !== 'done') return input.status
  if (input.prState !== 'open') return 'done'
  const endedAt = input.lastRun?.endedAt
  return input.cappedFeedbackAt.some((at) => !endedAt || at > endedAt) ? 'capped' : 'review'
}
