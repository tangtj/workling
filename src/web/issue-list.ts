import * as Type from 'typebox'
const nullableString = Type.Union([Type.String(), Type.Null()])
const obj = <T extends Type.TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false })
const platform = Type.Union([Type.Literal('github'), Type.Literal('gitlab')])
const status = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('done'),
  Type.Literal('failed'),
  Type.Literal('canceled'),
])
export const issueListSchema = obj({
  now: Type.String(),
  repos: Type.Array(
    obj({
      id: Type.Integer(),
      ref: Type.String(),
      platform,
      host: Type.String(),
      path: Type.String(),
      enabled: Type.Boolean(),
      tokenMask: Type.String(),
    }),
  ),
  issues: Type.Array(
    obj({
      id: Type.Integer(),
      repoId: Type.Integer(),
      number: Type.Integer(),
      title: nullableString,
      status,
      stage: Type.Union([
        status,
        Type.Literal('rework'),
        Type.Literal('review'),
        Type.Literal('capped'),
      ]),
      branch: nullableString,
      rounds: Type.Integer({ minimum: 0 }),
      prUrl: nullableString,
      prState: Type.Union([
        Type.Literal('open'),
        Type.Literal('merged'),
        Type.Literal('closed'),
        Type.Null(),
      ]),
      updatedAt: Type.String(),
      runCount: Type.Integer(),
      lastRun: Type.Union([
        Type.Null(),
        obj({
          kind: Type.Union([Type.Literal('implement'), Type.Literal('rework')]),
          startedAt: Type.String(),
          endedAt: nullableString,
          exitCode: Type.Union([Type.Integer(), Type.Null()]),
          error: nullableString,
        }),
      ]),
    }),
  ),
})
export type IssueListData = Type.Static<typeof issueListSchema>
