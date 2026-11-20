import { useSyncExternalStore } from 'react'

let paused = false
const listeners = new Set<() => void>()
export function setRefreshPaused(value: boolean) {
  if (paused === value) return
  paused = value
  listeners.forEach((listener) => listener())
}
export function useRefreshPaused() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => paused,
    () => false,
  )
}
