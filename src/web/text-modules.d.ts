declare module '*.css' {
  const text: string
  export default text
}

declare module '*/web/assets/app.js' {
  const text: string
  export default text
}

declare module '*/web/assets/login.js' {
  const text: string
  export default text
}

declare module '*/web/assets/timeline.js' {
  interface TimelineItem {
    id: string
    kind: 'step' | 'command' | 'codex' | 'file' | 'tool' | 'message' | 'warning' | 'exit' | 'output'
    text?: string
    lines?: string[]
    ts: string | null
    status?: 'running' | 'ok' | 'error'
  }
  interface TimelineState {
    items: TimelineItem[]
    calls: Map<string, TimelineItem>
    phase: number
    ts: string | null
  }
  export function createTimeline(): TimelineState
  export function applyWorklingLine(state: TimelineState, line: string): void
  export function applyPiLine(state: TimelineState, line: string): void
  export function applyLogLine(state: TimelineState, line: string): void
  export function phaseOf(state: TimelineState): number
  export function shouldReload(
    initiallyEnded: boolean,
    finished: boolean,
    previousEnded: boolean,
    progressed: boolean,
  ): boolean
  export function counts(state: TimelineState): {
    all: number
    command: number
    file: number
    message: number
    error: number
  }
}
declare module '*/web/assets/timeline.js?text' {
  const text: string
  export default text
}
declare module '*/web/assets/run-log.js' {
  const text: string
  export default text
}

declare module '*/web/assets/version.js' {
  const text: string
  export default text
}
