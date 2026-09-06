"use client"

import * as React from "react"

/**
 * sessionStorage as an external store for which groups are open, read
 * through useSyncExternalStore so the server render (no storage) and the
 * first client render agree, then the stored state syncs in without a
 * set-state-in-effect hydration step. Callers apply their own default for
 * a group the store has never heard of.
 */
const listeners = new Set<() => void>()

function readStore(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "{}"
  } catch {
    return "{}"
  }
}

function writeStore(key: string, value: Record<string, boolean>) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be full or blocked; the toggle is lost on remount only.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useGroupOpenState(key: string) {
  const raw = React.useSyncExternalStore(
    subscribe,
    () => readStore(key),
    () => "{}"
  )
  const openGroups = React.useMemo(() => {
    try {
      return JSON.parse(raw) as Record<string, boolean>
    } catch {
      return {}
    }
  }, [raw])
  const setGroupOpen = (id: string, open: boolean) =>
    writeStore(key, { ...openGroups, [id]: open })
  return { openGroups, setGroupOpen }
}
