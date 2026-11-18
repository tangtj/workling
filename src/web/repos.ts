import * as Type from 'typebox'

export const repoSchema = Type.Object(
  {
    id: Type.Integer(),
    ref: Type.String(),
    platform: Type.Union([Type.Literal('github'), Type.Literal('gitlab')]),
    host: Type.String(),
    path: Type.String(),
    token: Type.String(),
    enabled: Type.Boolean(),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
)
export const reposSchema = Type.Array(repoSchema)
