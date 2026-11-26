import * as Type from 'typebox'
import { taskRunKind } from './run-kind.ts'

const obj = <T extends Type.TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false })
const nullableString = Type.Union([Type.String(), Type.Null()])
const nullableInteger = Type.Union([Type.Integer(), Type.Null()])
export const issueDetailSchema = obj({
  now: Type.String(),
  issue: obj({
    id: Type.Integer(),
    repoId: Type.Integer(),
    repo: obj({
      ref: Type.String(),
      platform: Type.Union([Type.Literal('github'), Type.Literal('gitlab')]),
      host: Type.String(),
      path: Type.String(),
    }),
    number: Type.Integer(),
    title: nullableString,
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('running'),
      Type.Literal('done'),
      Type.Literal('failed'),
      Type.Literal('canceled'),
    ]),
    stage: Type.Union([
      Type.Literal('queued'),
      Type.Literal('running'),
      Type.Literal('rework'),
      Type.Literal('review'),
      Type.Literal('capped'),
      Type.Literal('failed'),
      Type.Literal('done'),
      Type.Literal('canceled'),
    ]),
    branch: nullableString,
    baseRef: nullableString,
    prUrl: nullableString,
    prState: Type.Union([
      Type.Literal('open'),
      Type.Literal('merged'),
      Type.Literal('closed'),
      Type.Null(),
    ]),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  }),
  triage: Type.Array(
    obj({
      id: Type.Integer(),
      decision: Type.Union([
        Type.Literal('accept'),
        Type.Literal('needs_info'),
        Type.Literal('ignore'),
        Type.Null(),
      ]),
      llmDecision: Type.Union([
        Type.Literal('accept'),
        Type.Literal('needs_info'),
        Type.Literal('ignore'),
        Type.Null(),
      ]),
      missing: Type.Array(Type.String()),
      triagedAt: Type.String(),
      suggestedAt: nullableString,
      suggestCommentUrl: nullableString,
      autoQueuedAt: nullableString,
    }),
  ),
  rework: obj({
    rounds: Type.Integer({ minimum: 0 }),
    limit: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }),
  runs: Type.Array(
    obj({
      id: Type.Integer(),
      worker: Type.String(),
      branch: nullableString,
      kind: Type.Union([taskRunKind, Type.Literal('review')]),
      children: Type.Optional(
        Type.Array(
          obj({
            number: Type.Integer(),
            title: Type.String(),
            url: Type.String(),
            linked: Type.Boolean(),
          }),
        ),
      ),
      startedAt: Type.String(),
      endedAt: nullableString,
      exitCode: nullableInteger,
      error: nullableString,
      summary: nullableString,
      reportResult: nullableString,
      logTail: nullableString,
      taskDir: nullableString,
      pid: nullableInteger,
      container: nullableString,
    }),
  ),
})
export type IssueDetailData = Type.Static<typeof issueDetailSchema>
