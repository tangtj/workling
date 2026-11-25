import * as Type from 'typebox'

export const reviewSchema = Type.Object({
  verdict: Type.Union([Type.Literal('pass'), Type.Literal('changes')]),
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  checks: Type.Array(
    Type.Object({
      command: Type.String({ minLength: 1, maxLength: 500 }),
      passed: Type.Boolean(),
      detail: Type.String({ maxLength: 2000 }),
    }),
    { maxItems: 20 },
  ),
  acceptance: Type.Array(
    Type.Object({
      item: Type.String({ minLength: 1, maxLength: 500 }),
      met: Type.Union([Type.Literal('yes'), Type.Literal('no'), Type.Literal('unverified')]),
      evidence: Type.String({ maxLength: 1000 }),
    }),
    { maxItems: 50 },
  ),
  findings: Type.Array(
    Type.Object({
      severity: Type.Union([Type.Literal('blocker'), Type.Literal('major'), Type.Literal('minor')]),
      path: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
      line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      scenario: Type.String({ minLength: 1, maxLength: 2000 }),
      body: Type.String({ minLength: 1, maxLength: 4000 }),
      known: Type.Boolean(),
    }),
    { maxItems: 30 },
  ),
})

export type Review = Type.Static<typeof reviewSchema>
