import * as Type from 'typebox'
const decision = Type.Union([
  Type.Literal('accept'),
  Type.Literal('needs_info'),
  Type.Literal('ignore'),
  Type.Null(),
])
const nullableString = Type.Union([Type.String(), Type.Null()])
export const triageSchema = Type.Object(
  {
    level: Type.Union([
      Type.Literal('off'),
      Type.Literal('shadow'),
      Type.Literal('suggest'),
      Type.Literal('auto'),
    ]),
    summary: Type.Object(
      {
        suggestions: Type.Object(
          {
            total: Type.Integer(),
            edited: Type.Integer(),
            readyWithoutEdit: Type.Integer(),
            pending: Type.Integer(),
          },
          { additionalProperties: false },
        ),
        total: Type.Integer(),
        acceptReady: Type.Integer(),
        acceptNotReady: Type.Integer(),
        otherReady: Type.Integer(),
        otherNotReady: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    records: Type.Array(
      Type.Object(
        {
          id: Type.Integer(),
          repoId: Type.Integer(),
          number: Type.Integer(),
          title: Type.String(),
          authorId: Type.String(),
          authorLogin: Type.String(),
          trust: Type.Union([Type.Literal('allowlist'), Type.Literal('write')]),
          contentHash: Type.String(),
          issueUpdatedAt: Type.String(),
          checks: Type.Object(
            {
              missingSections: Type.Array(Type.String()),
              invalidDirectives: Type.Array(Type.String()),
            },
            { additionalProperties: false },
          ),
          decision,
          llmDecision: decision,
          missing: Type.Array(Type.String()),
          note: nullableString,
          model: nullableString,
          error: nullableString,
          alreadyReady: Type.Boolean(),
          attempts: Type.Integer(),
          triagedAt: Type.String(),
          suggestedAt: nullableString,
          suggestCommentUrl: nullableString,
          suggestError: nullableString,
          labelRemovedAt: nullableString,
          autoQueuedAt: nullableString,
          followUp: Type.Union([
            Type.Literal('edited'),
            Type.Literal('readyWithoutEdit'),
            Type.Literal('pending'),
            Type.Null(),
          ]),
          readyAt: nullableString,
          readyAfterMinutes: Type.Union([Type.Integer(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export type TriageData = Type.Static<typeof triageSchema>

export const triageOverviewSchema = Type.Object(
  {
    repos: Type.Array(
      Type.Object(
        {
          id: Type.Integer(),
          ref: Type.String(),
          platform: Type.Union([Type.Literal('github'), Type.Literal('gitlab')]),
          host: Type.String(),
          path: Type.String(),
          enabled: Type.Boolean(),
          level: triageSchema.properties.level,
          summary: triageSchema.properties.summary,
        },
        { additionalProperties: false },
      ),
    ),
    summary: triageSchema.properties.summary,
    records: Type.Array(
      Type.Object(
        { ...triageSchema.properties.records.items.properties, repoRef: Type.String() },
        { additionalProperties: false },
      ),
    ),
    pendingSuggestions: Type.Integer(),
  },
  { additionalProperties: false },
)
export type TriageOverview = Type.Static<typeof triageOverviewSchema>
