import * as Type from 'typebox'

const nullableString = Type.Union([Type.String(), Type.Null()])
export const shellSchema = Type.Object(
  {
    version: Type.String(),
    repos: Type.Array(
      Type.Object(
        {
          id: Type.Integer({ minimum: 1 }),
          ref: Type.String(),
          enabled: Type.Boolean(),
          open: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    attention: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    running: Type.Integer({ minimum: 0 }),
    concurrency: Type.Integer({ minimum: 1 }),
    watch: Type.Union([
      Type.Null(),
      Type.Object(
        {
          worker: Type.String(),
          interval: Type.Number(),
          lastPollAt: nullableString,
          lastPollError: nullableString,
          workerError: nullableString,
        },
        { additionalProperties: false },
      ),
    ]),
    now: Type.String(),
  },
  { additionalProperties: false },
)

export type ShellData = Type.Static<typeof shellSchema>
