// Pi 工具事件没有时间戳；使用最近的 workling/session/message 时间作为可用基准。
export function createTimeline() {
  return { items: [], calls: new Map(), phase: 0, ts: null }
}
function parse(line) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' && typeof value.type === 'string' ? value : null
  } catch {
    return null
  }
}
function text(value) {
  return Array.isArray(value?.content)
    ? value.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    : ''
}
function timestamp(value) {
  if (
    (typeof value === 'string' || typeof value === 'number') &&
    Number.isFinite(new Date(value).getTime())
  )
    return new Date(value).toISOString()
  return null
}
function add(state, kind, fields, ts = state.ts) {
  const item = { id: `event-${state.items.length}`, kind, ts, ...fields }
  state.items.push(item)
  return item
}
function oversized(state, e) {
  if (e.type !== 'oversized_line') return false
  if (Number.isSafeInteger(e.bytes) && e.bytes >= 0)
    add(state, 'warning', { text: `一条事件过大（${Math.ceil(e.bytes / 1024)} KB），已省略` })
  return true
}
export function shouldReload(initiallyEnded, finished, previousEnded, progressed) {
  return !initiallyEnded && finished && previousEnded && !progressed
}
export function applyLogLine(state, line) {
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
export function applyWorklingLine(state, line) {
  const e = parse(line)
  if (e && oversized(state, e)) return
  if (!e || !timestamp(e.ts)) return
  if (e.type === 'step' && typeof e.text === 'string') {
    state.ts = timestamp(e.ts)
    add(state, 'step', { text: e.text })
  } else if (
    e.type === 'pi_exit' &&
    (e.code === null || Number.isInteger(e.code)) &&
    (e.signal === null || typeof e.signal === 'string') &&
    Number.isFinite(e.durationMs) &&
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
export function applyPiLine(state, line) {
  const e = parse(line)
  if (!e) return
  if (oversized(state, e)) return
  // 校验使用到的字段后再推进阶段，坏事件不能改变模型状态。
  if (e.type === 'tool_execution_start') {
    if (
      typeof e.toolCallId !== 'string' ||
      typeof e.toolName !== 'string' ||
      !e.args ||
      typeof e.args !== 'object' ||
      Array.isArray(e.args)
    )
      return
    if (e.toolName === 'bash' && typeof e.args.command !== 'string') return
    if (
      ['read', 'write', 'edit'].includes(e.toolName) &&
      ((e.args.path !== undefined && typeof e.args.path !== 'string') ||
        (e.args.file_path !== undefined && typeof e.args.file_path !== 'string'))
    )
      return
  }
  if (e.type === 'tool_execution_update' || e.type === 'tool_execution_end') {
    if (typeof e.toolCallId !== 'string' || typeof e.toolName !== 'string') return
    if (
      e.type === 'tool_execution_end' &&
      (typeof e.isError !== 'boolean' ||
        (e.durationMs !== undefined && (!Number.isFinite(e.durationMs) || e.durationMs < 0)))
    )
      return
  }
  if (
    e.type === 'message_end' &&
    (typeof e.message?.role !== 'string' ||
      (e.message.role === 'assistant' && !Array.isArray(e.message.content)))
  )
    return
  if (
    e.type === 'auto_retry_start' &&
    (!Number.isFinite(e.attempt) ||
      !Number.isFinite(e.maxAttempts) ||
      typeof e.errorMessage !== 'string')
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
  const ts = timestamp(e.timestamp) ?? timestamp(e.message?.timestamp)
  if (ts) state.ts = ts
  if (e.type === 'tool_execution_start') {
    if (state.calls.has(e.toolCallId)) return
    let item
    const base = { status: 'running', durationMs: 0 }
    if (e.toolName === 'bash') {
      const command = e.args.command
      if (command.includes('codex exec')) {
        const unquote = (v) => v?.replace(/^["']|["']$/g, '') ?? ''
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
    } else if (['read', 'write', 'edit'].includes(e.toolName)) {
      item = add(state, 'file', {
        ...base,
        action: { read: '读取', write: '写入', edit: '修改' }[e.toolName],
        path: e.args.path ?? e.args.file_path ?? e.toolName,
      })
    } else item = add(state, 'tool', { ...base, name: e.toolName })
    state.calls.set(e.toolCallId, item)
  } else if (e.type === 'tool_execution_update' || e.type === 'tool_execution_end') {
    const item = state.calls.get(e.toolCallId)
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
      item.durationMs = e.durationMs ?? 0
      if (item.kind === 'command' || item.kind === 'codex')
        item.output = text(e.result).slice(0, 20000)
    }
  } else if (e.type === 'message_end') {
    if (e.message?.role !== 'assistant') return
    const message = text(e.message)
    if (message.trim()) add(state, 'message', { text: message })
  } else if (
    e.type === 'auto_retry_start' &&
    Number.isFinite(e.attempt) &&
    Number.isFinite(e.maxAttempts) &&
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
export function phaseOf(state) {
  return state.phase
}
export function counts(state) {
  return {
    all: state.items.length,
    command: state.items.filter((i) => i.kind === 'command' || i.kind === 'codex').length,
    file: state.items.filter((i) => i.kind === 'file').length,
    message: state.items.filter((i) => i.kind === 'message').length,
    error: state.items.filter((i) => i.status === 'error' || i.kind === 'warning').length,
  }
}
