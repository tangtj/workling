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

export function reportResultLine(report: string): string | undefined {
  const inline = report.match(/^[ \t]*(?:[-*+][ \t]*)?结果[ \t]*[:：][ \t]*(.+)$/m)?.[1]?.trim()
  if (inline) return inline
  const lines = report.split(/\r?\n/)
  const heading = lines.findIndex((line) => /^ {0,3}#{1,6}[ \t]+结果[ \t]*[:：]?[ \t]*$/.test(line))
  if (heading === -1) return undefined
  const result = lines.slice(heading + 1).find((line) => line.trim())
  return result
    ?.trim()
    .replace(/^(?:[-*+]|\d+[.)])[ \t]+/, '')
    .trim()
}

export function reportOutcome(report: string): 'completed' | 'partial' | 'incomplete' {
  const result = reportResultLine(report)
  if (result?.startsWith('部分完成')) return 'partial'
  if (result?.startsWith('未完成')) return 'incomplete'
  if (result?.startsWith('完成')) return 'completed'
  return 'incomplete'
}

export function reportExcerpt(report: string): string {
  const lines = report.split(/\r?\n/)
  if (lines.length - Number(lines.at(-1) === '') <= 40) return report

  const heading = /^ {0,3}(#{1,6})(?!#)[ \t]*/
  const listItem = /^-[ \t]+[^:：]+[:：]/
  const start = lines.findIndex(
    (line) =>
      /^ {0,3}#{1,6}[ \t]*未完成与存疑/.test(line) || /^-[ \t]+未完成与存疑[ \t]*[:：]/.test(line),
  )
  if (start === -1) return lines.slice(0, 40).join('\n')
  const level = lines[start]!.match(heading)?.[1]?.length
  const section = [lines[start]!]
  for (const line of lines.slice(start + 1, start + 40)) {
    const nextLevel = line.match(heading)?.[1]?.length
    if (level ? nextLevel && nextLevel <= level : nextLevel || listItem.test(line)) break
    section.push(line)
  }
  return [...lines.slice(0, 15), '…', ...section].join('\n')
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
    const result = reportResultLine(report)
    if (result) reportResult = redact(result, secrets).slice(0, 50)
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
