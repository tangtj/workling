import * as Type from 'typebox'
import * as Value from 'typebox/value'
import { missingOutput, readOutputFile } from './output-file.ts'

export const planSchema = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2000 }),
  docs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 30 }),
  children: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200 }),
      body: Type.String({ minLength: 1, maxLength: 60_000 }),
    }),
    { minItems: 1, maxItems: 10 },
  ),
})

export type Plan = Type.Static<typeof planSchema>

export async function readPlan(dir: string): Promise<Plan> {
  const raw = await readOutputFile(dir, 'plan.json', 1024 * 1024).catch((cause: unknown) => {
    if (missingOutput(cause)) throw new Error('缺少 out/plan.json', { cause })
    throw cause
  })
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch (cause) {
    throw new Error('out/plan.json 不是有效的 JSON', { cause })
  }
  if (!Value.Check(planSchema, value)) throw new Error('out/plan.json 的结构无效')
  return value
}
