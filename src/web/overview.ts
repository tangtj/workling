import * as Type from 'typebox'
import { taskRunKind } from './run-kind.ts'
const obj = <T extends Type.TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false })
const nullableString = Type.Union([Type.String(), Type.Null()])
const run = obj({
  id: Type.Integer(),
  kind: taskRunKind,
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
      workerError: nullableString,
    }),
  ]),
  alerts: Type.Array(
    obj({
      kind: Type.Union([Type.Literal('poll'), Type.Literal('worker')]),
      message: Type.String(),
    }),
  ),
  attention: Type.Array(
    obj({
      kind: Type.Union([
        Type.Literal('failed'),
        Type.Literal('capped'),
        Type.Literal('review'),
        Type.Literal('needs_info'),
        Type.Literal('plan_pending'),
      ]),
      repoId: Type.Integer(),
      repoRef: Type.String(),
      number: Type.Integer(),
      title: nullableString,
      issueId: Type.Union([Type.Integer(), Type.Null()]),
      url: Type.String(),
      prUrl: nullableString,
      since: Type.String(),
      reason: Type.String(),
      logRunId: Type.Union([Type.Integer(), Type.Null()]),
    }),
  ),
  reworked: Type.Integer(),
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
      round: Type.Integer(),
      lastRun: Type.Union([run, Type.Null()]),
      runs: Type.Array(run),
    }),
  ),
})
export type OverviewData = Type.Static<typeof overviewSchema>
