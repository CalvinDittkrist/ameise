import { useSyncExternalStore } from "react"

// The one clock of the page: a single interval, running while some span reads it, ticks the current
// time once a second. Every span rendered in the same tick reads the same now.
const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined

const tick = () => {
  now = Date.now()
  for (const changed of listeners) changed()
}

const subscribe = (changed: () => void) => {
  if (listeners.size === 0) {
    now = Date.now()
    timer = setInterval(tick, 1000)
  }
  listeners.add(changed)
  return () => {
    listeners.delete(changed)
    if (listeners.size === 0) clearInterval(timer)
  }
}

// useNow is what read makes of the ticking current time. A component re-renders only when that value
// changes, so a span that shows minutes re-renders once a minute, though the clock ticks each second.
// read answers a value that compares equal across calls with the same now, such as a string.
export function useNow<T>(read: (now: number) => T): T {
  // Before the first span subscribes the clock is stale, and a first render reads the time itself.
  return useSyncExternalStore(subscribe, () => read(listeners.size > 0 ? now : Date.now()))
}
