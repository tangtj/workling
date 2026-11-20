import { useEffect, useEffectEvent, useState } from 'react'
import * as Type from 'typebox'
import * as Value from 'typebox/value'
import {
  applyLogLine,
  applyPiLine,
  applyWorklingLine,
  createTimeline,
  shouldReload,
  type TimelineItem,
} from '../timeline.ts'
import { readResponse } from './http.ts'

const offsetSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const linesSchema = Type.Object({ lines: Type.Array(Type.String()) })
const streamSchema = Type.Object({ ...linesSchema.properties, offset: offsetSchema })
const batchSchema = Type.Object({
  workling: streamSchema,
  pi: streamSchema,
  fallback: Type.Union([linesSchema, Type.Null()]),
  ended: Type.Boolean(),
})
type Batch = Type.Static<typeof batchSchema>
const exitSchema = Type.Object({ type: Type.Literal('pi_exit') })
const errorSchema = Type.Object({ error: Type.String() })
const pollMs = 3000

export function createRunEvents(initiallyEnded: boolean) {
  return {
    state: createTimeline(),
    workling: 0,
    pi: 0,
    ended: false,
    initiallyEnded,
    fallbackText: null as string | null,
    generation: 0,
    exitSeen: false,
    finalWorkling: [] as string[],
    stop: false,
    finishedWhileViewing: false,
  }
}

export function processRunEvents(
  previous: ReturnType<typeof createRunEvents>,
  batch: Batch | { logTail: string },
) {
  if ('logTail' in batch) {
    const state = createTimeline()
    batch.logTail.split(/\r?\n/).forEach((line) => applyLogLine(state, line))
    return {
      ...previous,
      state,
      fallbackText: batch.logTail,
      generation: previous.generation + 1,
      ended: true,
      stop: true,
      finishedWhileViewing: false,
    }
  }
  const fallbackText = batch.fallback?.lines.join('\n') ?? null
  const backToEvents = !batch.fallback && previous.fallbackText !== null
  const progressed =
    (batch.fallback !== null && fallbackText !== previous.fallbackText) ||
    batch.workling.offset !== previous.workling ||
    (!batch.fallback && batch.pi.offset !== previous.pi)
  let state = previous.state
  let exitSeen = previous.exitSeen
  const finalWorkling = [...previous.finalWorkling]
  if (batch.fallback || backToEvents) state = createTimeline()
  else if (
    batch.workling.lines.length ||
    batch.pi.lines.length ||
    (!progressed && finalWorkling.length)
  ) {
    // The parser updates running tools in place. Keep published snapshots intact.
    const calls = new Map(previous.state.calls)
    const updated = new Map<string, TimelineItem>()
    if (batch.pi.lines.length) {
      for (const [id, item] of calls) {
        if (item.status !== 'running') continue
        const copy = { ...item }
        updated.set(item.id, copy)
        calls.set(id, copy)
      }
    }
    state = {
      ...previous.state,
      calls,
      items: previous.state.items.map((item) => updated.get(item.id) ?? item),
    }
  }
  batch.fallback?.lines.forEach((line, index, lines) => {
    if (index < lines.length - 1 || line !== '') applyLogLine(state, line)
  })
  for (const line of batch.workling.lines) {
    // The streams have no shared sequence number. Hold the exit and later rows until Pi drains.
    if (!exitSeen) {
      try {
        exitSeen = Value.Check(exitSchema, JSON.parse(line))
      } catch {
        // The model ignores malformed lines.
      }
    }
    if (exitSeen) finalWorkling.push(line)
    else applyWorklingLine(state, line)
  }
  if (!batch.fallback) batch.pi.lines.forEach((line) => applyPiLine(state, line))
  if (!progressed) finalWorkling.splice(0).forEach((line) => applyWorklingLine(state, line))
  return {
    ...previous,
    state,
    workling: batch.workling.offset,
    pi: batch.fallback ? 0 : batch.pi.offset,
    ended: batch.ended,
    fallbackText,
    generation: previous.generation + Number(backToEvents),
    exitSeen,
    finalWorkling,
    stop: batch.ended && previous.ended && !progressed,
    finishedWhileViewing: shouldReload(
      previous.initiallyEnded,
      batch.ended,
      previous.ended,
      progressed,
    ),
  }
}

async function requestLog(url: string, signal: AbortSignal) {
  const response = await readResponse(url, { signal })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    throw new Error(Value.Check(errorSchema, body) && body.error ? body.error : '加载失败')
  }
  return response
}

export function useRunEvents({
  runId,
  initiallyEnded,
  enabled,
  logTail,
}: {
  runId: number
  initiallyEnded: boolean
  enabled: boolean
  logTail?: string | null
}) {
  const [events, setEvents] = useState(() => createRunEvents(initiallyEnded))
  const [error, setError] = useState<string | null>(null)
  const readLogTail = useEffectEvent(() => logTail)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const { signal } = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    let current = createRunEvents(initiallyEnded)
    setEvents(current)
    setError(null)
    const load = async () => {
      try {
        const url = `/api/runs/${runId}/events?workling=${current.workling}&pi=${current.pi}`
        const body: unknown = await (await requestLog(url, signal)).json()
        if (signal.aborted) return
        if (!Value.Check(batchSchema, body)) throw new Error('加载失败')
        current = processRunEvents(current, body)
        setEvents(current)
        if (!current.stop) timer = setTimeout(load, current.ended ? 0 : pollMs)
      } catch (error) {
        if (signal.aborted) return
        const message = error instanceof Error ? error.message : '加载失败'
        const logTail = readLogTail()
        if (message === '日志已清理' && logTail) {
          setEvents(processRunEvents(current, { logTail }))
        } else setError(message)
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [runId, initiallyEnded, enabled])
  return { ...events, fallback: events.fallbackText !== null, error }
}

export function useRawLog(runId: number, enabled: boolean) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const { signal } = controller
    const decoder = new TextDecoder()
    let timer: ReturnType<typeof setTimeout> | undefined
    let offset = 0
    let ended = false
    setText('')
    setError(null)
    const load = async () => {
      try {
        const response = await requestLog(`/api/runs/${runId}/log?offset=${offset}`, signal)
        const bytes = await response.arrayBuffer()
        if (signal.aborted) return
        const header = response.headers.get('X-Log-Offset')
        const next = Number(header)
        if (!header || !/^\d+$/.test(header) || !Value.Check(offsetSchema, next))
          throw new Error('加载失败')
        const progressed = next !== offset
        const finished = response.headers.get('X-Run-Ended') === 'true'
        const stop = finished && ended && !progressed
        let content = decoder.decode(bytes, { stream: true })
        if (stop) content += decoder.decode()
        if (content) setText((previous) => previous + content)
        offset = next
        ended = finished
        if (!stop) timer = setTimeout(load, progressed || ended ? 0 : pollMs)
      } catch (error) {
        if (!signal.aborted) setError(error instanceof Error ? error.message : '加载失败')
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [runId, enabled])
  return error ?? (text || '暂无原始日志')
}
