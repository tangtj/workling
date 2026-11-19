import * as Type from 'typebox'

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
  runs: Type.Array(
    obj({
      id: Type.Integer(),
      worker: Type.String(),
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
