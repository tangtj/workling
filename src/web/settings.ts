import * as Type from 'typebox'

const nullableString = Type.Union([Type.String(), Type.Null()])
export const piSettingsSchema = Type.Object(
  {
    model: Type.String(),
    effort: Type.Union(['low', 'medium', 'high', 'xhigh'].map((v) => Type.Literal(v))),
    piModel: nullableString,
    llmBaseUrl: nullableString,
    llmApiKey: nullableString,
    llmApi: Type.Union([Type.Literal('openai-responses'), Type.Literal('openai-completions')]),
    gitName: Type.String(),
    gitEmail: Type.String(),
  },
  { additionalProperties: false },
)
export const executorSettingsSchema = Type.Object(
  {
    concurrency: Type.Number(),
    sandbox: Type.Union([Type.Literal('none'), Type.Literal('docker')]),
    taskImage: Type.String(),
    taskCpus: Type.Number(),
    taskMemory: Type.String(),
    taskPids: Type.Number(),
    taskNetwork: nullableString,
  },
  { additionalProperties: false },
)
export const settingsSchema = Type.Object(
  {
    pi: piSettingsSchema,
    executor: executorSettingsSchema,
    startup: Type.Union([
      Type.Object(
        {
          workspace: Type.String(),
          worker: Type.String(),
          host: Type.String(),
          port: Type.Number(),
          allowedHosts: Type.Array(Type.String()),
          secureCookie: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    labels: Type.Array(
      Type.Object(
        { name: Type.String(), description: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
export type SettingsData = Type.Static<typeof settingsSchema>
