import * as Type from 'typebox'

const nullableString = Type.Union([Type.String(), Type.Null()])
const nullableNumber = Type.Union([Type.Integer(), Type.Null()])
export const trustedUserSchema = Type.Object(
  {
    id: Type.Integer(),
    repoId: Type.Integer(),
    userId: Type.String(),
    login: Type.String(),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
)
export const trustedUsersSchema = Type.Array(trustedUserSchema)
export const feedbackSchema = Type.Array(
  Type.Object(
    {
      id: Type.Integer(),
      repoId: Type.Integer(),
      issueId: Type.Integer(),
      prNumber: nullableNumber,
      source: Type.String(),
      externalId: Type.String(),
      authorId: Type.String(),
      authorLogin: Type.String(),
      trust: Type.String(),
      isCommand: Type.Boolean(),
      instruction: nullableString,
      body: Type.String(),
      path: nullableString,
      line: nullableNumber,
      reviewState: nullableString,
      url: Type.String(),
      status: Type.String(),
      runId: nullableNumber,
      createdAt: Type.String(),
      updatedAt: Type.String(),
      seenAt: Type.String(),
    },
    { additionalProperties: false },
  ),
)
