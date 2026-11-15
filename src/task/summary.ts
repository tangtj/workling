import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Type from 'typebox'
import * as Value from 'typebox/value'

const eventSchema = Type.Object({
  type: Type.Literal('message_end'),
  message: Type.Object({
    role: Type.Literal('assistant'),
    content: Type.Array(Type.Unknown()),
  }),
})
const textSchema = Type.Object({ type: Type.Literal('text'), text: Type.String() })

export function redact(value: string, secrets: string[]): string {
  return secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join('***'), value)
}

export async function extractSummary(taskDir: string, secrets: string[]) {
  let summary: string | null = null
  let reportResult: string | null = null
  let logTail: string | null = null
  try {
    const events = await readFile(join(taskDir, 'pi-events.jsonl'), 'utf8')
    for (const line of events.split('\n')) {
      try {
        const event: unknown = JSON.parse(line)
        if (Value.Check(eventSchema, event))
          summary = event.message.content
            .filter((part) => Value.Check(textSchema, part))
            .map((part) => part.text)
            .join('')
      } catch {
        /* 跳过损坏的事件行。 */
      }
    }
    if (summary !== null) {
      summary = redact(summary, secrets)
      if (summary.length > 4000) summary = `${summary.slice(0, 4000)}…`
    }
  } catch {
    /* 文件不可读时保留 null。 */
  }
  try {
    const report = await readFile(join(taskDir, 'report.md'), 'utf8')
    const match = report.match(/^\s*[-*]?\s*结果\s*[:：]\s*(.+)$/m)
    if (match) reportResult = redact(match[1]!.trim(), secrets).slice(0, 50)
  } catch {
    /* 文件不可读时保留 null。 */
  }
  try {
    const log = redact(await readFile(join(taskDir, 'task.log'), 'utf8'), secrets)
    const lines = log.split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop()
    logTail = lines.slice(-50).join('\n').slice(-8000)
  } catch {
    /* 文件不可读时保留 null。 */
  }
  return { summary, reportResult, logTail }
}
