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

// 与 src/contract/out.ts 的取值一致；这里单独声明，避免浏览器端打包引入读文件的契约模块。
export const runExecutor = Type.Union([
  Type.Literal('pi'),
  Type.Literal('codex'),
  Type.Literal('mixed'),
])
export const runDifficulty = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
])
export const runClarity = Type.Union([Type.Literal('clear'), Type.Literal('unclear')])

export const executorLabels = {
  pi: 'Pi',
  codex: 'codex',
  mixed: 'Pi + codex',
} satisfies Record<Type.Static<typeof runExecutor>, string>
export const difficultyLabels = {
  low: '难度低',
  medium: '难度中',
  high: '难度高',
} satisfies Record<Type.Static<typeof runDifficulty>, string>
export const clarityLabels = {
  clear: '说明清楚',
  unclear: '说明不清楚',
} satisfies Record<Type.Static<typeof runClarity>, string>

/** 「难度中 · 说明清楚」；没有评估时为空。 */
export function assessmentText(run: {
  difficulty: Type.Static<typeof runDifficulty> | null
  clarity: Type.Static<typeof runClarity> | null
}): string {
  return [
    run.difficulty && difficultyLabels[run.difficulty],
    run.clarity && clarityLabels[run.clarity],
  ]
    .filter(Boolean)
    .join(' · ')
}
