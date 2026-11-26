import * as Type from 'typebox'

export const taskRunKind = Type.Union([
  Type.Literal('implement'),
  Type.Literal('rework'),
  Type.Literal('plan'),
])
export type TaskRunKind = Type.Static<typeof taskRunKind>

export const runKindLabels = {
  implement: '实现',
  rework: '返工',
  review: '评审',
  plan: '拆解',
} satisfies Record<TaskRunKind | 'review', string>
