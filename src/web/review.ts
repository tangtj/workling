import * as Type from 'typebox'
import { reviewSchema } from '../contract/review.ts'

const nullableString = Type.Union([Type.String(), Type.Null()])

export const issueReviewSchema = Type.Object({
  id: Type.Integer(),
  status: Type.Union([
    Type.Literal('queued'),
    Type.Literal('running'),
    Type.Literal('done'),
    Type.Literal('failed'),
    Type.Literal('skipped'),
  ]),
  verdict: Type.Union([reviewSchema.properties.verdict, Type.Null()]),
  summary: nullableString,
  checks: reviewSchema.properties.checks,
  acceptance: reviewSchema.properties.acceptance,
  findings: reviewSchema.properties.findings,
  error: nullableString,
  model: nullableString,
  effort: nullableString,
  partial: Type.Boolean(),
  headSha: Type.String(),
  runId: Type.Union([Type.Integer(), Type.Null()]),
  deliveryRunId: Type.Integer(),
  createdAt: Type.String(),
  endedAt: nullableString,
})
export const issueReviewsSchema = Type.Array(issueReviewSchema)
export type IssueReview = Type.Static<typeof issueReviewSchema>
