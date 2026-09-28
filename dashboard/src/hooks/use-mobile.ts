import { useSyncExternalStore } from "react"

const MOBILE_BREAKPOINT = 768
const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

const subscribe = (changed: () => void) => {
  const mql = matchMedia(query)
  mql.addEventListener("change", changed)
  return () => mql.removeEventListener("change", changed)
}

// useIsMobile says whether the window is narrower than a tablet, and follows it as it is resized.
export function useIsMobile() {
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches)
}
