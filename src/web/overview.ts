import * as Type from 'typebox'
const obj = <T extends Type.TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false })
const nullableString = Type.Union([Type.String(), Type.Null()])
const run = obj({
  id: Type.Integer(),
  startedAt: Type.String(),
  endedAt: nullableString,
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  error: nullableString,
})
export const overviewSchema = obj({
  now: Type.String(),
  repos: obj({ total: Type.Integer(), enabled: Type.Integer() }),
  concurrency: Type.Integer(),
  watch: Type.Union([
    Type.Null(),
    obj({
      worker: Type.String(),
      timeout: Type.Number(),
      lastPollAt: nullableString,
      lastPollError: nullableString,
    }),
  ]),
  issues: Type.Array(
    obj({
      id: Type.Integer(),
      repoId: Type.Integer(),
      repoRef: Type.String(),
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
      updatedAt: Type.String(),
      runCount: Type.Integer(),
      lastRun: Type.Union([run, Type.Null()]),
      runs: Type.Array(run),
    }),
  ),
})
export type OverviewData = Type.Static<typeof overviewSchema>
