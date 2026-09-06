import * as React from "react"

const subscribe = () => () => {}

/**
 * False on the server and during hydration, true once React owns the page.
 * A form rendered on the server is typeable before React attaches to it, and
 * whatever was typed in that gap is thrown away the moment it does; a field
 * that reads as read-only until then loses nothing.
 */
export function useHydrated(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
}
