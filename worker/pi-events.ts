import * as Type from 'typebox'
import * as Value from 'typebox/value'

const eventSchema = Type.Object({ type: Type.String() }, { additionalProperties: true })
const startSchema = Type.Object({
  toolCallId: Type.String(),
  toolName: Type.String(),
  args: Type.Unknown(),
})
const textSchema = Type.Object({ content: Type.Array(Type.Unknown()) })
const blockSchema = Type.Object({ type: Type.Literal('text'), text: Type.String() })
const messageSchema = Type.Object({
  message: Type.Object({ role: Type.Literal('assistant'), content: Type.Array(Type.Unknown()) }),
})
const retrySchema = Type.Object({
  attempt: Type.Number(),
  maxAttempts: Type.Number(),
  errorMessage: Type.String(),
})
const retryEndSchema = Type.Object({ success: Type.Literal(false), finalError: Type.String() })
const compactionSchema = Type.Object({ reason: Type.String() })
const endSchema = Type.Object({
  toolCallId: Type.String(),
  toolName: Type.String(),
  isError: Type.Boolean(),
  durationMs: Type.Optional(Type.Number()),
  result: Type.Optional(Type.Unknown()),
})
const argsSchema = Type.Object({
  command: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  file_path: Type.Optional(Type.String()),
})
const updateSchema = Type.Object({
  toolCallId: Type.String(),
  toolName: Type.String(),
  partialResult: Type.Optional(Type.Unknown()),
})

export function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
export function time(now: Date): string {
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}
function content(value: unknown): string {
  return Value.Check(textSchema, value)
    ? value.content
        .filter((block) => Value.Check(blockSchema, block))
        .map((block) => block.text)
        .join('')
    : ''
}
function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value
}

export function createPiEventFormatter(options: {
  secrets: string[]
  now?: () => Date
}): (line: string) => string[] {
  const now = options.now ?? (() => new Date())
  const calls = new Map<string, { start: number; last: number; updated: boolean }>()
  return (line) => {
    const date = now()
    const output = (lines: string[]) =>
      lines.map((value) => {
        let result = `[pi ${time(date)}] ${value}`
        for (const secret of options.secrets.filter(Boolean))
          result = result.replaceAll(secret, '***')
        return result
      })
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return output([line])
    }
    if (!Value.Check(eventSchema, event)) return []
    switch (event.type) {
      case 'tool_execution_start': {
        if (!Value.Check(startSchema, event)) return []
        calls.set(event.toolCallId, { start: date.getTime(), last: date.getTime(), updated: false })
        const args = Value.Check(argsSchema, event.args) ? event.args : {}
        if (event.toolName === 'bash' && typeof args.command === 'string') {
          const lines = args.command.split('\n')
          return output([
            `$ ${truncate(lines[0]!)}${lines.length > 1 ? `（共 ${lines.length} 行）` : ''}`,
          ])
        }
        const verb = { read: '读', write: '写', edit: '改' }[event.toolName]
        if (verb) return output([`${verb} ${args.path ?? args.file_path ?? event.toolName}`])
        return output([`调用 ${event.toolName}`])
      }
      case 'tool_execution_update': {
        if (!Value.Check(updateSchema, event)) return []
        let call = calls.get(event.toolCallId)
        if (!call) {
          call = { start: date.getTime(), last: date.getTime(), updated: false }
          calls.set(event.toolCallId, call)
          return []
        }
        if (!call.updated) {
          call.updated = true
          return []
        }
        if (date.getTime() - call.last < 30_000) return []
        call.last = date.getTime()
        const last =
          content(event.partialResult)
            .split('\n')
            .filter((s) => s.trim())
            .at(-1) ?? ''
        return output([
          `… ${event.toolName} 进行中（已 ${duration(date.getTime() - call.start)}）：${truncate(last)}`,
        ])
      }
      case 'tool_execution_end': {
        if (!Value.Check(endSchema, event)) return []
        const call = calls.get(event.toolCallId)
        calls.delete(event.toolCallId)
        const elapsed = event.durationMs ?? (call ? date.getTime() - call.start : 0)
        if (event.isError) {
          const first =
            content(event.result)
              .split('\n')
              .find((s) => s.trim()) ?? ''
          return output([`✗ ${event.toolName} 失败（${duration(elapsed)}）：${truncate(first)}`])
        }
        return event.durationMs !== undefined && event.durationMs >= 10_000
          ? output([`✓ ${event.toolName} 完成（${duration(elapsed)}）`])
          : []
      }
      case 'message_end':
        return Value.Check(messageSchema, event)
          ? output(
              content(event.message)
                .split('\n')
                .filter((s) => s.trim()),
            )
          : []
      case 'auto_retry_start':
        return Value.Check(retrySchema, event)
          ? output([
              `模型请求失败，第 ${event.attempt}/${event.maxAttempts} 次重试：${event.errorMessage}`,
            ])
          : []
      case 'auto_retry_end':
        return Value.Check(retryEndSchema, event) ? output([`重试失败：${event.finalError}`]) : []
      case 'compaction_start':
        return Value.Check(compactionSchema, event) ? output([`压缩上下文（${event.reason}）`]) : []
      default:
        return []
    }
  }
}
