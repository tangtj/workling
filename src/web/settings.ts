import * as Type from 'typebox'

const effort = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
])
const nullableString = Type.Union([Type.String(), Type.Null()])
export const piSettingsSchema = Type.Object(
  {
    model: Type.String(),
    effort,
    reviewModel: nullableString,
    reviewEffort: Type.Union([effort, Type.Null()]),
    planModel: nullableString,
    planEffort: Type.Union([effort, Type.Null()]),
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
export const updateSettingsSchema = Type.Object(
  { channel: Type.Union([Type.Literal('stable'), Type.Literal('edge')]) },
  { additionalProperties: false },
)
export const settingsSchema = Type.Object(
  {
    update: updateSettingsSchema,
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
