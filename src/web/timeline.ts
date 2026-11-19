// 6a：React 日志页使用本文件；旧 Issue 详情仍用 timeline.js，待 6b 移除。
// Pi 工具事件没有时间戳；使用最近的 workling/session/message 时间作为可用基准。
type ToolFields = { status: 'running' | 'ok' | 'error'; durationMs: number }
type ItemFields = {
  step: { text: string }
  message: { text: string }
  warning: { text: string }
  exit: { text?: string; code?: number | null; signal?: string | null; durationMs?: number }
  output: { lines: string[] }
  command: ToolFields & { command: string; output: string }
  codex: ToolFields & {
    command: string
    model: string
    effort: string
    startedAt: string | null
    latest: string
    output: string
  }
  file: ToolFields & { action: string; path: string }
  tool: ToolFields & { name: string }
}
type Item<K extends keyof ItemFields> = { id: string; kind: K; ts: string | null } & ItemFields[K]
export type TimelineItem = { [K in keyof ItemFields]: Item<K> }[keyof ItemFields]
type ToolItem = Extract<TimelineItem, ToolFields>
export type TimelineState = {
  items: TimelineItem[]
  calls: Map<string, ToolItem>
  phase: number
  ts: string | null
}

export function createTimeline(): TimelineState {
  return { items: [], calls: new Map(), phase: 0, ts: null }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function parse(line: string) {
  try {
    const value: unknown = JSON.parse(line)
    return object(value) && typeof value.type === 'string' ? value : null
  } catch {
    return null
  }
}
function text(value: unknown) {
  return object(value) && Array.isArray(value.content)
    ? value.content
        .filter(
          (b: unknown): b is { text: string } =>
            object(b) && b.type === 'text' && typeof b.text === 'string',
        )
        .map((b) => b.text)
        .join('')
    : ''
}
function timestamp(value: unknown) {
  if (
    (typeof value === 'string' || typeof value === 'number') &&
    Number.isFinite(new Date(value).getTime())
  )
    return new Date(value).toISOString()
  return null
}
function add<K extends keyof ItemFields>(
  state: TimelineState,
  kind: K,
  fields: ItemFields[K],
  ts = state.ts,
): Item<K> {
  const item = { id: `event-${state.items.length}`, kind, ts, ...fields }
  // kind determines the fields supplied at every call site.
  state.items.push(item as TimelineItem)
  return item
}
function oversized(state: TimelineState, e: Record<string, unknown>) {
  if (e.type !== 'oversized_line') return false
  if (typeof e.bytes === 'number' && Number.isSafeInteger(e.bytes) && e.bytes >= 0)
    add(state, 'warning', { text: `一条事件过大（${Math.ceil(e.bytes / 1024)} KB），已省略` })
  return true
}
export function shouldReload(
  initiallyEnded: boolean,
  finished: boolean,
  previousEnded: boolean,
  progressed: boolean,
) {
  return !initiallyEnded && finished && previousEnded && !progressed
}
export function applyLogLine(state: TimelineState, line: string) {
  const match = line.match(/^\[(workling|pi) (\d\d:\d\d:\d\d)\] (.*)$/)
  if (match) {
    const [, source, ts, text] = match
    if (source === 'pi') {
      state.phase = Math.max(state.phase, 1)
      add(state, 'message', { text }, ts)
    } else {
      if (/^Pi 结束：|^Pi 被信号/.test(text)) {
        const code = text.match(/退出码 (-?\d+)/)
        const signal = text.match(/^Pi 被信号\s*(\S+?)\s*(?:结束|终止|，|$)/)
        const duration = text.match(/用时 (?:(\d+) 分 )?(\d+(?:\.\d+)?) 秒/)
        add(
          state,
          'exit',
          {
            text,
            ...(code ? { code: Number(code[1]) } : {}),
            ...(signal ? { signal: signal[1] } : {}),
            ...(duration
              ? { durationMs: ((Number(duration[1]) || 0) * 60 + Number(duration[2])) * 1000 }
              : {}),
          },
          ts,
        )
      } else add(state, 'step', { text }, ts)
    }
    return
  }
  let item = state.items.at(-1)
  if (item?.kind !== 'output') item = add(state, 'output', { lines: [] }, null)
  if (line.trim() || item.lines.at(-1) !== '') item.lines.push(line.trim() ? line : '')
}
export function applyWorklingLine(state: TimelineState, line: string) {
  const e = parse(line)
  if (e && oversized(state, e)) return
  if (!e || !timestamp(e.ts)) return
  if (e.type === 'step' && typeof e.text === 'string') {
    state.ts = timestamp(e.ts)
    add(state, 'step', { text: e.text })
  } else if (
    e.type === 'pi_exit' &&
    (e.code === null || (typeof e.code === 'number' && Number.isInteger(e.code))) &&
    (e.signal === null || typeof e.signal === 'string') &&
    finite(e.durationMs) &&
    e.durationMs >= 0
  ) {
    add(
      state,
      'exit',
      { code: e.code, signal: e.signal, durationMs: e.durationMs },
      timestamp(e.ts),
    )
  }
}
export function applyPiLine(state: TimelineState, line: string) {
  const e = parse(line)
  if (!e) return
  if (oversized(state, e)) return
  const message = object(e.message) ? e.message : undefined
  const args = object(e.args) && !Array.isArray(e.args) ? e.args : undefined
  const { toolCallId, toolName } = e
  const command = typeof args?.command === 'string' ? args.command : undefined
  const fileAction =
    toolName === 'read'
      ? '读取'
      : toolName === 'write'
        ? '写入'
        : toolName === 'edit'
          ? '修改'
          : null
  // 校验使用到的字段后再推进阶段，坏事件不能改变模型状态。
  if (e.type === 'tool_execution_start') {
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string' || !args) return
    if (toolName === 'bash' && command === undefined) return
    if (
      fileAction !== null &&
      ((args.path !== undefined && typeof args.path !== 'string') ||
        (args.file_path !== undefined && typeof args.file_path !== 'string'))
    )
      return
  }
  if (e.type === 'tool_execution_update' || e.type === 'tool_execution_end') {
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string') return
    if (
      e.type === 'tool_execution_end' &&
      (typeof e.isError !== 'boolean' ||
        (e.durationMs !== undefined && (!finite(e.durationMs) || e.durationMs < 0)))
    )
      return
  }
  if (
    e.type === 'message_end' &&
    (typeof message?.role !== 'string' ||
      (message.role === 'assistant' && !Array.isArray(message.content)))
  )
    return
  if (
    e.type === 'auto_retry_start' &&
    (!finite(e.attempt) || !finite(e.maxAttempts) || typeof e.errorMessage !== 'string')
  )
    return
  if (
    e.type === 'auto_retry_end' &&
    (typeof e.success !== 'boolean' || (e.success === false && typeof e.finalError !== 'string'))
  )
    return
  if (e.type === 'compaction_start' && typeof e.reason !== 'string') return
  // 未知但有效的 Pi 事件也表示已进入 Pi 阶段。
  state.phase = Math.max(state.phase, 1)
  const ts = timestamp(e.timestamp) ?? timestamp(message?.timestamp)
  if (ts) state.ts = ts
  if (e.type === 'tool_execution_start') {
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string' || !args) return
    if (state.calls.has(toolCallId)) return
    let item: ToolItem
    const base: ToolFields = { status: 'running', durationMs: 0 }
    if (toolName === 'bash') {
      if (command === undefined) return
      if (command.includes('codex exec')) {
        const unquote = (v: string | undefined) => v?.replace(/^["']|["']$/g, '') ?? ''
        item = add(state, 'codex', {
          ...base,
          command,
          model: unquote(command.match(/(?:^|\s)-m\s+("[^"]*"|'[^']*'|\S+)/)?.[1]),
          effort: command.match(/model_reasoning_effort\s*=\s*["']?([\w-]+)/)?.[1] ?? '',
          startedAt: state.ts,
          latest: '',
          output: '',
        })
        state.phase = Math.max(state.phase, 2)
      } else {
        if (state.items.some((i) => i.kind === 'codex' && i.status !== 'running'))
          state.phase = Math.max(state.phase, 3)
        item = add(state, 'command', { ...base, command, output: '' })
      }
      if (command.includes('git push') || command.includes('gh pr create')) state.phase = 4
    } else if (fileAction !== null) {
      item = add(state, 'file', {
        ...base,
        action: fileAction,
        path:
          typeof args.path === 'string'
            ? args.path
            : typeof args.file_path === 'string'
              ? args.file_path
              : toolName,
      })
    } else item = add(state, 'tool', { ...base, name: toolName })
    state.calls.set(toolCallId, item)
  } else if (e.type === 'tool_execution_update' || e.type === 'tool_execution_end') {
    if (typeof toolCallId !== 'string') return
    const item = state.calls.get(toolCallId)
    if (!item || item.status !== 'running') return
    if (e.type === 'tool_execution_update') {
      if (item.kind === 'codex')
        item.latest =
          text(e.partialResult)
            .split('\n')
            .filter((s) => s.trim())
            .at(-1) ?? ''
    } else {
      item.status = e.isError ? 'error' : 'ok'
      item.durationMs = typeof e.durationMs === 'number' ? e.durationMs : 0
      if (item.kind === 'command' || item.kind === 'codex')
        item.output = text(e.result).slice(0, 20000)
    }
  } else if (e.type === 'message_end') {
    if (message?.role !== 'assistant') return
    const content = text(message)
    if (content.trim()) add(state, 'message', { text: content })
  } else if (
    e.type === 'auto_retry_start' &&
    finite(e.attempt) &&
    finite(e.maxAttempts) &&
    typeof e.errorMessage === 'string'
  ) {
    add(state, 'warning', {
      text: `模型请求失败，第 ${e.attempt}/${e.maxAttempts} 次重试：${e.errorMessage}`,
    })
  } else if (
    e.type === 'auto_retry_end' &&
    e.success === false &&
    typeof e.finalError === 'string'
  ) {
    add(state, 'warning', { text: `重试失败：${e.finalError}` })
  } else if (e.type === 'compaction_start' && typeof e.reason === 'string') {
    add(state, 'warning', { text: `压缩上下文（${e.reason}）` })
  }
}
export function phaseOf(state: TimelineState) {
  return state.phase
}
export function counts(state: TimelineState) {
  return {
    all: state.items.length,
    command: state.items.filter((i) => i.kind === 'command' || i.kind === 'codex').length,
    file: state.items.filter((i) => i.kind === 'file').length,
    message: state.items.filter((i) => i.kind === 'message').length,
    error: state.items.filter(
      (i) => ('status' in i && i.status === 'error') || i.kind === 'warning',
    ).length,
  }
}
