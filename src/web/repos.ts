import * as Type from 'typebox'

export const reviewLevelSchema = Type.Union([Type.Literal('off'), Type.Literal('shadow')])
export type ReviewLevel = Type.Static<typeof reviewLevelSchema>

export const repoSchema = Type.Object(
  {
    id: Type.Integer(),
    ref: Type.String(),
    platform: Type.Union([Type.Literal('github'), Type.Literal('gitlab')]),
    host: Type.String(),
    path: Type.String(),
    token: Type.String(),
    enabled: Type.Boolean(),
    triageLevel: Type.Union([
      Type.Literal('off'),
      Type.Literal('shadow'),
      Type.Literal('suggest'),
      Type.Literal('auto'),
    ]),
    triageSince: Type.Union([Type.String(), Type.Null()]),
    reviewLevel: reviewLevelSchema,
    reviewSince: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
)
export const reposSchema = Type.Array(repoSchema)
